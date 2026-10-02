import { useEffect, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  approveAndSendLabel,
  declineReturnRequest,
  markReceived,
  refundReturn,
} from "../services/returns.server";
import type { DeclineReason } from "../services/shopify-returns.server";
import { formatMoney } from "../lib/returns";
import { StatusBadge } from "../components/StatusBadge";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const rr = await db.returnRequest.findFirst({
    where: { id: params.id, shop: session.shop },
    include: { items: true, events: { orderBy: { createdAt: "desc" } } },
  });
  if (!rr) throw new Response("Return not found", { status: 404 });
  return { rr };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");
  const id = params.id!;

  try {
    switch (intent) {
      case "approve":
        await approveAndSendLabel(admin, session.shop, id);
        return { ok: true, message: "Return approved and label sent" };
      case "decline":
        await declineReturnRequest(
          admin,
          session.shop,
          id,
          (form.get("reason") as DeclineReason) || "OTHER",
          String(form.get("note") ?? ""),
        );
        return { ok: true, message: "Return declined" };
      case "receive":
        await markReceived(admin, session.shop, id);
        return { ok: true, message: "Marked as received" };
      case "refund":
        await refundReturn(admin, session.shop, id);
        return { ok: true, message: "Refund issued" };
      default:
        return { ok: false, message: "Unknown action" };
    }
  } catch (error) {
    if (error instanceof Response) throw error;
    const message = (error as Error).message;
    await db.returnEvent.create({
      data: { returnRequestId: id, type: "ERROR", message, actor: "merchant" },
    });
    return { ok: false, message };
  }
};

const DECLINE_LABELS: Record<DeclineReason, string> = {
  RETURN_PERIOD_ENDED: "Return period ended",
  FINAL_SALE: "Final sale item",
  OTHER: "Other",
};

export default function ReturnDetail() {
  const { rr } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [declining, setDeclining] = useState(false);
  const busy = fetcher.state !== "idle";
  const pendingIntent = fetcher.formData?.get("intent");
  const currency = rr.currencyCode ?? "USD";
  const itemsValue = rr.items.reduce(
    (sum, i) => sum + i.quantity * i.unitPrice,
    0,
  );

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
      if (fetcher.data.ok) setDeclining(false);
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const submit = (intent: string, extra: Record<string, string> = {}) =>
    fetcher.submit({ intent, ...extra }, { method: "POST" });

  const loading = (intent: string) =>
    busy && pendingIntent === intent ? { loading: true } : {};

  return (
    <s-page heading={rr.returnName ?? rr.orderName}>
      <s-link slot="breadcrumb-actions" href="/app/returns">
        Returns
      </s-link>

      {rr.status === "REQUESTED" && (
        <>
          <s-button
            slot="primary-action"
            variant="primary"
            disabled={busy}
            {...loading("approve")}
            onClick={() => submit("approve")}
          >
            Approve &amp; send label
          </s-button>
          <s-button
            slot="secondary-actions"
            tone="critical"
            disabled={busy}
            onClick={() => setDeclining(true)}
          >
            Decline
          </s-button>
        </>
      )}
      {rr.status === "APPROVED" && (
        <s-button
          slot="primary-action"
          variant="primary"
          disabled={busy}
          {...loading("approve")}
          onClick={() => submit("approve")}
        >
          Generate return label
        </s-button>
      )}
      {rr.status === "LABEL_SENT" && (
        <s-button
          slot="primary-action"
          variant="primary"
          disabled={busy}
          {...loading("receive")}
          onClick={() => submit("receive")}
        >
          Mark as received
        </s-button>
      )}
      {rr.status === "RECEIVED" && (
        <s-button
          slot="primary-action"
          variant="primary"
          disabled={busy}
          {...loading("refund")}
          onClick={() => submit("refund")}
        >
          Issue refund
        </s-button>
      )}

      {declining && (
        <s-section heading="Decline this return">
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="decline" />
            <s-stack gap="base">
              <s-select label="Reason" name="reason">
                {Object.entries(DECLINE_LABELS).map(([value, label]) => (
                  <s-option key={value} value={value}>
                    {label}
                  </s-option>
                ))}
              </s-select>
              <s-text-area
                label="Message to customer"
                name="note"
                maxLength={500}
                rows={3}
              />
              <s-stack direction="inline" gap="small-200">
                <s-button
                  type="submit"
                  tone="critical"
                  variant="primary"
                  {...loading("decline")}
                >
                  Decline return
                </s-button>
                <s-button onClick={() => setDeclining(false)}>Cancel</s-button>
              </s-stack>
            </s-stack>
          </fetcher.Form>
        </s-section>
      )}

      <s-section heading="Items">
        <s-stack gap="base">
          {rr.items.map((item) => (
            <s-stack
              key={item.id}
              direction="inline"
              gap="base"
              alignItems="center"
            >
              <s-thumbnail
                src={item.imageUrl ?? undefined}
                alt={item.title}
                size="small"
              />
              <s-stack gap="small-100">
                <s-text type="strong">{item.title}</s-text>
                {item.variantTitle && (
                  <s-text color="subdued">{item.variantTitle}</s-text>
                )}
                <s-text color="subdued">
                  {item.quantity} × {formatMoney(item.unitPrice, currency)}
                  {item.sku ? ` · SKU ${item.sku}` : ""}
                </s-text>
                <s-stack direction="inline" gap="small-200">
                  <s-badge>{item.reasonName}</s-badge>
                  {item.customerNote && (
                    <s-text color="subdued">“{item.customerNote}”</s-text>
                  )}
                </s-stack>
              </s-stack>
            </s-stack>
          ))}
          <s-divider />
          <s-stack direction="inline" justifyContent="space-between">
            <s-text>Item value</s-text>
            <s-text type="strong">{formatMoney(itemsValue, currency)}</s-text>
          </s-stack>
          {rr.refundAmount !== null && (
            <s-stack direction="inline" justifyContent="space-between">
              <s-text>Refunded</s-text>
              <s-text type="strong">
                {formatMoney(rr.refundAmount, currency)}
              </s-text>
            </s-stack>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Timeline">
        <s-stack gap="base">
          {rr.events.map((e) => (
            <s-stack key={e.id} gap="small-100">
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <s-text type="strong">
                  {e.type.replaceAll("_", " ").toLowerCase()}
                </s-text>
                <s-text color="subdued">
                  {new Date(e.createdAt).toLocaleString()} · {e.actor}
                </s-text>
              </s-stack>
              <s-text tone={e.type === "ERROR" ? "critical" : "auto"}>
                {e.message}
              </s-text>
            </s-stack>
          ))}
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Summary">
        <s-stack gap="small-300">
          <StatusBadge status={rr.status} />
          <s-text>Order {rr.orderName}</s-text>
          <s-text>{rr.customerName ?? "Customer"}</s-text>
          {rr.customerEmail && (
            <s-text color="subdued">{rr.customerEmail}</s-text>
          )}
          <s-text color="subdued">
            Source: {rr.source === "PORTAL" ? "Return portal" : "Shopify admin"}
          </s-text>
          <s-text color="subdued">
            Requested {new Date(rr.requestedAt).toLocaleString()}
          </s-text>
          {rr.declineNote && (
            <s-text color="subdued">Decline note: {rr.declineNote}</s-text>
          )}
        </s-stack>
      </s-section>

      {rr.trackingNumber && (
        <s-section slot="aside" heading="Return shipment">
          <s-stack gap="small-300">
            <s-text>{rr.carrier}</s-text>
            {rr.trackingUrl ? (
              <s-link href={rr.trackingUrl} target="_blank">
                {rr.trackingNumber}
              </s-link>
            ) : (
              <s-text>{rr.trackingNumber}</s-text>
            )}
            {rr.labelUrl && (
              <s-button href={rr.labelUrl} target="_blank" icon="print">
                Print label
              </s-button>
            )}
            {rr.labelCost ? (
              <s-text color="subdued">
                Postage {formatMoney(rr.labelCost)}
              </s-text>
            ) : null}
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
