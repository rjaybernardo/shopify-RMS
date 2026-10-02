import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import {
  Form,
  useLoaderData,
  useNavigate,
  useSearchParams,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { Prisma } from "@prisma/client";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { STATUSES, STATUS_LABELS, formatMoney } from "../lib/returns";
import { StatusBadge } from "../components/StatusBadge";

const PAGE_SIZE = 25;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const status = url.searchParams.get("status") || "";
  const q = url.searchParams.get("q")?.trim() || "";
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);

  const where: Prisma.ReturnRequestWhereInput = {
    shop: session.shop,
    ...(status ? { status } : {}),
    ...(q
      ? {
          OR: [
            { orderName: { contains: q } },
            { returnName: { contains: q } },
            { customerEmail: { contains: q } },
            { customerName: { contains: q } },
            { trackingNumber: { contains: q } },
          ],
        }
      : {}),
  };

  const [returns, count] = await Promise.all([
    db.returnRequest.findMany({
      where,
      orderBy: { requestedAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { items: true },
    }),
    db.returnRequest.count({ where }),
  ]);

  return {
    returns: returns.map((r) => ({
      id: r.id,
      name: r.returnName ?? r.orderName,
      orderName: r.orderName,
      customer: r.customerName || r.customerEmail || "—",
      status: r.status,
      units: r.items.reduce((n, i) => n + i.quantity, 0),
      value: formatMoney(
        r.refundAmount ??
          r.items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0),
        r.currencyCode ?? "USD",
      ),
      reason: [...new Set(r.items.map((i) => i.reasonName))].join(", "),
      requestedAt: r.requestedAt.toISOString(),
    })),
    page,
    hasNextPage: page * PAGE_SIZE < count,
  };
};

export default function ReturnsIndex() {
  const { returns, page, hasNextPage } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const navigate = useNavigate();

  const go = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    navigate(`?${next.toString()}`);
  };

  return (
    <s-page heading="Returns" inlineSize="large">
      <s-section padding="none">
        <s-table
          paginate
          hasPreviousPage={page > 1}
          hasNextPage={hasNextPage}
          onPreviousPage={() => go({ page: String(page - 1) })}
          onNextPage={() => go({ page: String(page + 1) })}
        >
          <s-grid slot="filters" gridTemplateColumns="1fr auto" gap="small-200">
            <Form method="get">
              {params.get("status") && (
                <input
                  type="hidden"
                  name="status"
                  value={params.get("status")!}
                />
              )}
              <s-search-field
                name="q"
                label="Search returns"
                labelAccessibilityVisibility="exclusive"
                placeholder="Order, return, customer or tracking number"
                defaultValue={params.get("q") ?? ""}
              />
            </Form>
            <s-select
              label="Status"
              labelAccessibilityVisibility="exclusive"
              value={params.get("status") ?? ""}
              onChange={(e) =>
                go({ status: e.currentTarget.value, page: null })
              }
            >
              <s-option value="">All statuses</s-option>
              {STATUSES.map((s) => (
                <s-option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </s-option>
              ))}
            </s-select>
          </s-grid>
          <s-table-header-row>
            <s-table-header listSlot="primary">Return</s-table-header>
            <s-table-header listSlot="secondary">Customer</s-table-header>
            <s-table-header>Order</s-table-header>
            <s-table-header listSlot="inline">Status</s-table-header>
            <s-table-header listSlot="labeled">Reason</s-table-header>
            <s-table-header format="numeric">Units</s-table-header>
            <s-table-header format="numeric">Value</s-table-header>
            <s-table-header listSlot="kicker">Requested</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {returns.map((r) => (
              <s-table-row key={r.id}>
                <s-table-cell>
                  <s-link href={`/app/returns/${r.id}`}>{r.name}</s-link>
                </s-table-cell>
                <s-table-cell>{r.customer}</s-table-cell>
                <s-table-cell>{r.orderName}</s-table-cell>
                <s-table-cell>
                  <StatusBadge status={r.status} />
                </s-table-cell>
                <s-table-cell>{r.reason}</s-table-cell>
                <s-table-cell>{r.units}</s-table-cell>
                <s-table-cell>{r.value}</s-table-cell>
                <s-table-cell>
                  {new Date(r.requestedAt).toLocaleDateString()}
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
        {!returns.length && (
          <s-box padding="large">
            <s-text color="subdued">No returns match these filters.</s-text>
          </s-box>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
