import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getAnalytics } from "../services/returns.server";
import { formatMoney } from "../lib/returns";
import { StatusBadge } from "../components/StatusBadge";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const days = Number(new URL(request.url).searchParams.get("days")) || 30;

  const [analytics, recent] = await Promise.all([
    getAnalytics(session.shop, days),
    db.returnRequest.findMany({
      where: { shop: session.shop },
      orderBy: { requestedAt: "desc" },
      take: 5,
      include: { items: { select: { quantity: true } } },
    }),
  ]);
  return { analytics, recent };
};

const formatHours = (h: number | null) =>
  h === null
    ? "—"
    : h < 24
      ? `${h.toFixed(1)} h`
      : `${(h / 24).toFixed(1)} days`;

function Kpi({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <s-box padding="base" border="base" borderRadius="base" background="base">
      <s-stack gap="small-200">
        <s-text color="subdued">{label}</s-text>
        <s-heading>{value}</s-heading>
        {hint && <s-text color="subdued">{hint}</s-text>}
      </s-stack>
    </s-box>
  );
}

function BarList({
  rows,
}: {
  rows: { label: string; value: number; display: string }[];
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) return <s-text color="subdued">No data yet.</s-text>;
  return (
    <s-stack gap="small-300">
      {rows.map((r) => (
        <s-stack key={r.label} gap="small-100">
          <s-stack direction="inline" justifyContent="space-between">
            <s-text>{r.label}</s-text>
            <s-text color="subdued">{r.display}</s-text>
          </s-stack>
          <div
            style={{
              height: 8,
              borderRadius: 4,
              background: "var(--p-color-bg-surface-secondary, #f1f1f1)",
            }}
          >
            <div
              style={{
                width: `${(r.value / max) * 100}%`,
                height: "100%",
                borderRadius: 4,
                background: "var(--p-color-bg-fill-info, #2c6ecb)",
              }}
            />
          </div>
        </s-stack>
      ))}
    </s-stack>
  );
}

function VolumeChart({ daily }: { daily: { date: string; count: number }[] }) {
  const max = Math.max(1, ...daily.map((d) => d.count));
  return (
    <div
      role="img"
      aria-label="Returns requested per day"
      style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 120 }}
    >
      {daily.map((d) => (
        <div
          key={d.date}
          title={`${d.date}: ${d.count} return(s)`}
          style={{
            flex: 1,
            height: `${Math.max((d.count / max) * 100, d.count ? 4 : 1)}%`,
            background: d.count
              ? "var(--p-color-bg-fill-info, #2c6ecb)"
              : "var(--p-color-border, #e3e3e3)",
            borderRadius: "3px 3px 0 0",
          }}
        />
      ))}
    </div>
  );
}

export default function Dashboard() {
  const { analytics: a, recent } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const navigate = useNavigate();

  return (
    <s-page heading="Returns dashboard">
      <s-button
        slot="primary-action"
        variant="primary"
        href="/app/returns?status=REQUESTED"
      >
        Review requests ({a.awaitingReview})
      </s-button>

      <s-section>
        <s-stack
          direction="inline"
          justifyContent="space-between"
          alignItems="center"
        >
          <s-heading>Overview</s-heading>
          <s-select
            label="Date range"
            labelAccessibilityVisibility="exclusive"
            value={params.get("days") ?? "30"}
            onChange={(e) => navigate(`?days=${e.currentTarget.value}`)}
          >
            <s-option value="7">Last 7 days</s-option>
            <s-option value="30">Last 30 days</s-option>
            <s-option value="90">Last 90 days</s-option>
          </s-select>
        </s-stack>
        <s-box paddingBlockStart="base">
          <s-grid
            gridTemplateColumns="repeat(auto-fit, minmax(160px, 1fr))"
            gap="base"
          >
            <Kpi
              label="Returns"
              value={String(a.total)}
              hint={`${a.open} open`}
            />
            <Kpi
              label="Refunded"
              value={formatMoney(a.refundedTotal, a.currency)}
            />
            <Kpi
              label="Avg. time to approve"
              value={formatHours(a.avgHoursToApprove)}
            />
            <Kpi
              label="Avg. time to refund"
              value={formatHours(a.avgHoursToRefund)}
            />
            <Kpi
              label="Label spend"
              value={formatMoney(a.labelSpend, a.currency)}
            />
          </s-grid>
        </s-box>
      </s-section>

      <s-section heading="Return volume">
        <VolumeChart daily={a.daily} />
        <s-stack direction="inline" justifyContent="space-between">
          <s-text color="subdued">{a.daily[0]?.date}</s-text>
          <s-text color="subdued">{a.daily.at(-1)?.date}</s-text>
        </s-stack>
      </s-section>

      <s-section heading="Recent returns">
        {recent.length ? (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Return</s-table-header>
              <s-table-header>Order</s-table-header>
              <s-table-header listSlot="inline">Status</s-table-header>
              <s-table-header format="numeric">Items</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {recent.map((r) => (
                <s-table-row key={r.id}>
                  <s-table-cell>
                    <s-link href={`/app/returns/${r.id}`}>
                      {r.returnName ?? r.orderName}
                    </s-link>
                  </s-table-cell>
                  <s-table-cell>{r.orderName}</s-table-cell>
                  <s-table-cell>
                    <StatusBadge status={r.status} />
                  </s-table-cell>
                  <s-table-cell>
                    {r.items.reduce((n, i) => n + i.quantity, 0)}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        ) : (
          <s-paragraph>
            No returns yet. Add the return portal link to your store so
            customers can start a return — see{" "}
            <s-link href="/app/settings">Settings</s-link>.
          </s-paragraph>
        )}
      </s-section>

      <s-section slot="aside" heading="Top return reasons">
        <BarList
          rows={a.reasons.map((r) => ({
            label: r.name,
            value: r.units,
            display: `${r.units} units`,
          }))}
        />
      </s-section>

      <s-section slot="aside" heading="Most returned products">
        <BarList
          rows={a.topProducts.map((p) => ({
            label: p.title,
            value: p.units,
            display: `${p.units} · ${formatMoney(p.value, a.currency)}`,
          }))}
        />
      </s-section>

      <s-section slot="aside" heading="Pipeline">
        <s-stack gap="small-200">
          {Object.entries(a.byStatus).map(([status, count]) => (
            <s-stack
              key={status}
              direction="inline"
              justifyContent="space-between"
            >
              <StatusBadge status={status} />
              <s-text>{count}</s-text>
            </s-stack>
          ))}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
