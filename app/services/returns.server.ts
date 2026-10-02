import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { ReturnRequest } from "@prisma/client";
import db from "../db.server";
import {
  approveReturn,
  attachReturnLabel,
  declineReturn,
  getLabelAddresses,
  getReturnForProcessing,
  processReturnWithRefund,
  requestReturn,
  type DeclineReason,
  type ReturnableItem,
  type ReturnReason,
  type ShopifyOrder,
} from "./shopify-returns.server";
import { getLabelProvider } from "./shipping.server";
import { sendEmail, templates } from "./email.server";
import {
  STATUSES,
  STATUS_LABELS,
  formatMoney,
  type ReturnStatus,
} from "../lib/returns";

type Admin = Pick<AdminApiContext, "graphql">;

export { STATUSES, STATUS_LABELS, formatMoney, type ReturnStatus };

// Forward-only ordering so webhook echoes of our own mutations never regress a return.
const STATUS_RANK: Record<ReturnStatus, number> = {
  REQUESTED: 0,
  APPROVED: 1,
  LABEL_SENT: 2,
  RECEIVED: 3,
  REFUNDED: 4,
  CLOSED: 5,
  DECLINED: 5,
  CANCELED: 5,
};

export async function getSettings(shop: string) {
  return db.shopSettings.upsert({
    where: { shop },
    create: { shop },
    update: {},
  });
}

async function logEvent(
  returnRequestId: string,
  type: string,
  message: string,
  actor = "system",
) {
  await db.returnEvent.create({
    data: { returnRequestId, type, message, actor },
  });
}

async function getOwnedReturn(shop: string, id: string) {
  const rr = await db.returnRequest.findFirst({ where: { id, shop } });
  if (!rr) throw new Response("Return not found", { status: 404 });
  return rr;
}

// ---------------------------------------------------------------------------
// Customer portal
// ---------------------------------------------------------------------------

export function isWithinReturnWindow(order: ShopifyOrder, windowDays: number) {
  const ageMs = Date.now() - new Date(order.processedAt).getTime();
  return ageMs <= windowDays * 24 * 60 * 60 * 1000;
}

export async function createPortalReturn({
  admin,
  shop,
  order,
  selections,
  returnable,
  reasons,
}: {
  admin: Admin;
  shop: string;
  order: ShopifyOrder;
  selections: {
    fulfillmentLineItemId: string;
    quantity: number;
    reasonId: string;
    note?: string;
  }[];
  returnable: ReturnableItem[];
  reasons: ReturnReason[];
}) {
  const settings = await getSettings(shop);

  // Never trust client quantities: clamp against what Shopify says is returnable.
  const lines = selections.flatMap((s) => {
    const item = returnable.find(
      (i) => i.fulfillmentLineItemId === s.fulfillmentLineItemId,
    );
    const reason = reasons.find((r) => r.id === s.reasonId);
    const quantity = Math.min(Math.floor(s.quantity), item?.quantity ?? 0);
    return item && reason && quantity > 0
      ? [{ ...s, item, reason, quantity }]
      : [];
  });
  if (!lines.length) throw new Error("Select at least one item and a reason.");

  const shopifyReturn = await requestReturn(
    admin,
    order.id,
    lines.map((l) => ({
      fulfillmentLineItemId: l.fulfillmentLineItemId,
      quantity: l.quantity,
      returnReasonDefinitionId: l.reason.id,
      ...(l.note ? { customerNote: l.note.slice(0, 300) } : {}),
    })),
  );

  const rr = await db.returnRequest.create({
    data: {
      shop,
      shopifyReturnId: shopifyReturn.id,
      returnName: shopifyReturn.name,
      orderId: order.id,
      orderName: order.name,
      customerEmail: order.email ?? "",
      customerName: order.customer?.displayName,
      currencyCode: order.currencyCode,
      status: "REQUESTED",
      source: "PORTAL",
      customerNote:
        lines
          .map((l) => l.note)
          .filter(Boolean)
          .join(" · ") || null,
      items: {
        create: lines.map((l) => ({
          fulfillmentLineItemId: l.fulfillmentLineItemId,
          title: l.item.title,
          variantTitle: l.item.variantTitle,
          sku: l.item.sku,
          imageUrl: l.item.imageUrl,
          quantity: l.quantity,
          unitPrice: l.item.unitPrice,
          reasonHandle: l.reason.handle,
          reasonName: l.reason.name,
          customerNote: l.note || null,
        })),
      },
      events: {
        create: {
          type: "REQUESTED",
          actor: "customer",
          message: `Customer requested a return of ${lines.reduce((n, l) => n + l.quantity, 0)} item(s) via the return portal.`,
        },
      },
    },
  });

  if (rr.customerEmail) {
    await sendEmail({
      to: rr.customerEmail,
      ...templates.requested(rr.orderName, rr.returnName ?? rr.orderName),
    });
  }
  if (settings.notifyMerchantEmail) {
    const storeHandle = shop.replace(".myshopify.com", "");
    await sendEmail({
      to: settings.notifyMerchantEmail,
      ...templates.merchantNewReturn(
        rr.orderName,
        lines.length,
        `https://admin.shopify.com/store/${storeHandle}/apps/${process.env.SHOPIFY_API_KEY}/app/returns/${rr.id}`,
      ),
    });
  }

  if (settings.autoApprove) {
    try {
      await approveAndSendLabel(admin, shop, rr.id, "auto-approve");
    } catch (error) {
      await logEvent(
        rr.id,
        "ERROR",
        `Auto-approve failed: ${(error as Error).message}`,
      );
    }
  }

  return rr;
}

// ---------------------------------------------------------------------------
// Merchant actions
// ---------------------------------------------------------------------------

/** Approve in Shopify, buy a return label, attach it as a reverse delivery and email it. */
export async function approveAndSendLabel(
  admin: Admin,
  shop: string,
  id: string,
  actor = "merchant",
) {
  let rr = await getOwnedReturn(shop, id);
  if (!rr.shopifyReturnId) throw new Error("Return is not linked to Shopify.");

  let reverseFulfillmentOrderIds: string[];
  if (rr.status === "REQUESTED") {
    const approved = await approveReturn(admin, rr.shopifyReturnId);
    reverseFulfillmentOrderIds = approved.reverseFulfillmentOrders.nodes.map(
      (n) => n.id,
    );
    rr = await db.returnRequest.update({
      where: { id },
      data: { status: "APPROVED", approvedAt: new Date() },
    });
    await logEvent(id, "APPROVED", "Return approved.", actor);
  } else if (rr.status === "APPROVED") {
    // Retry label generation for an already-approved return.
    const { shopifyReturn } = await getReturnForProcessing(
      admin,
      rr.shopifyReturnId,
    );
    reverseFulfillmentOrderIds =
      shopifyReturn.reverseFulfillmentOrders.nodes.map((n) => n.id);
  } else {
    throw new Error(
      `Cannot approve a return that is ${STATUS_LABELS[rr.status as ReturnStatus]}.`,
    );
  }

  return generateLabel(admin, rr, reverseFulfillmentOrderIds, actor);
}

async function generateLabel(
  admin: Admin,
  rr: ReturnRequest,
  reverseFulfillmentOrderIds: string[],
  actor: string,
) {
  const provider = getLabelProvider();
  const items = await db.returnLineItem.findMany({
    where: { returnRequestId: rr.id },
  });
  const addresses = await getLabelAddresses(admin, rr.orderId);

  const label = await provider.createReturnLabel({
    from: { ...addresses.customer, email: rr.customerEmail },
    to: addresses.store,
    weightOz: items.reduce((oz, i) => oz + i.quantity * 16, 0),
    reference: rr.returnName ?? rr.orderName,
  });

  await attachReturnLabel(admin, reverseFulfillmentOrderIds, label);

  const updated = await db.returnRequest.update({
    where: { id: rr.id },
    data: {
      status: "LABEL_SENT",
      labelSentAt: new Date(),
      carrier: label.carrier,
      trackingNumber: label.trackingNumber,
      trackingUrl: label.trackingUrl,
      labelUrl: label.labelUrl,
      labelToken: label.labelToken,
      labelCost: label.cost,
    },
  });
  await logEvent(
    rr.id,
    "LABEL_SENT",
    `${provider.name} label created (${label.carrier} ${label.trackingNumber}) and emailed to the customer.`,
    actor,
  );

  if (rr.customerEmail) {
    await sendEmail({
      to: rr.customerEmail,
      ...templates.approved(rr.orderName, label),
    });
  }
  return updated;
}

export async function declineReturnRequest(
  admin: Admin,
  shop: string,
  id: string,
  reason: DeclineReason,
  note?: string,
) {
  const rr = await getOwnedReturn(shop, id);
  if (rr.status !== "REQUESTED")
    throw new Error("Only requested returns can be declined.");
  if (rr.shopifyReturnId)
    await declineReturn(admin, rr.shopifyReturnId, reason, note);

  const updated = await db.returnRequest.update({
    where: { id },
    data: {
      status: "DECLINED",
      declineReason: reason,
      declineNote: note || null,
      closedAt: new Date(),
    },
  });
  await logEvent(
    id,
    "DECLINED",
    `Return declined (${reason.replaceAll("_", " ").toLowerCase()}).`,
    "merchant",
  );
  if (rr.customerEmail) {
    await sendEmail({
      to: rr.customerEmail,
      ...templates.declined(rr.orderName, note),
    });
  }
  return updated;
}

/** Marks the package as received; refunds automatically when the shop has auto-refund enabled. */
export async function markReceived(
  admin: Admin,
  shop: string,
  id: string,
  actor = "merchant",
) {
  const rr = await getOwnedReturn(shop, id);
  if (!["APPROVED", "LABEL_SENT"].includes(rr.status)) {
    throw new Error("Only approved returns can be marked as received.");
  }
  await db.returnRequest.update({
    where: { id },
    data: { status: "RECEIVED", receivedAt: new Date() },
  });
  await logEvent(
    id,
    "RECEIVED",
    "Returned package received at the warehouse.",
    actor,
  );

  const settings = await getSettings(shop);
  if (settings.autoRefundOnReceipt) {
    return refundReturn(admin, shop, id, "auto-refund");
  }
  return db.returnRequest.findUniqueOrThrow({ where: { id } });
}

export async function refundReturn(
  admin: Admin,
  shop: string,
  id: string,
  actor = "merchant",
) {
  const rr = await getOwnedReturn(shop, id);
  if (rr.status !== "RECEIVED")
    throw new Error("Mark the return as received before refunding.");
  if (!rr.shopifyReturnId) throw new Error("Return is not linked to Shopify.");

  const settings = await getSettings(shop);
  const result = await processReturnWithRefund(admin, rr.shopifyReturnId, {
    restock: settings.restockOnReceipt,
  });

  const updated = await db.returnRequest.update({
    where: { id },
    data: {
      status: "REFUNDED",
      refundedAt: new Date(),
      refundAmount: result.refundAmount,
      currencyCode: result.currencyCode ?? rr.currencyCode,
    },
  });
  const amount = formatMoney(
    result.refundAmount,
    updated.currencyCode ?? "USD",
  );
  await logEvent(
    id,
    "REFUNDED",
    `Refunded ${amount} to the original payment method${settings.restockOnReceipt ? " and restocked items" : ""}.`,
    actor,
  );
  if (rr.customerEmail) {
    await sendEmail({
      to: rr.customerEmail,
      ...templates.refunded(rr.orderName, amount),
    });
  }
  return updated;
}

// ---------------------------------------------------------------------------
// Webhook sync (returns created or changed directly in the Shopify admin)
// ---------------------------------------------------------------------------

export type ReturnWebhookPayload = {
  admin_graphql_api_id: string;
  name?: string;
  status?: string;
  order?: { admin_graphql_api_id: string };
  return_line_items?: {
    quantity: number;
    return_reason?: string;
    customer_note?: string | null;
    fulfillment_line_item?: { admin_graphql_api_id: string };
  }[];
  decline?: { reason?: string; note?: string | null };
};

const TOPIC_STATUS: Record<string, ReturnStatus> = {
  RETURNS_REQUEST: "REQUESTED",
  RETURNS_APPROVE: "APPROVED",
  RETURNS_DECLINE: "DECLINED",
  RETURNS_CANCEL: "CANCELED",
  RETURNS_CLOSE: "CLOSED",
};

export async function syncReturnFromWebhook(
  shop: string,
  topic: string,
  payload: ReturnWebhookPayload,
) {
  const shopifyReturnId = payload.admin_graphql_api_id;
  const next = TOPIC_STATUS[topic];
  let rr = await db.returnRequest.findUnique({ where: { shopifyReturnId } });

  if (!rr) {
    if (!payload.order) return;
    // A return the merchant created in Shopify admin; mirror it for analytics.
    rr = await db.returnRequest.create({
      data: {
        shop,
        shopifyReturnId,
        returnName: payload.name,
        orderId: payload.order.admin_graphql_api_id,
        orderName: payload.name?.replace(/-R\d+$/, "") ?? "Unknown order",
        customerEmail: "",
        status: next ?? "REQUESTED",
        source: "SHOPIFY_ADMIN",
        approvedAt: next === "APPROVED" ? new Date() : null,
        items: {
          create: (payload.return_line_items ?? []).map((li) => ({
            fulfillmentLineItemId:
              li.fulfillment_line_item?.admin_graphql_api_id ?? "",
            title: "Line item",
            quantity: li.quantity,
            unitPrice: 0,
            reasonHandle: li.return_reason ?? "other",
            reasonName: (li.return_reason ?? "other").replaceAll("_", " "),
            customerNote: li.customer_note ?? null,
          })),
        },
        events: {
          create: {
            type: "SYNCED",
            message: "Return created in Shopify admin.",
          },
        },
      },
    });
    return;
  }

  if (!next || STATUS_RANK[next] <= STATUS_RANK[rr.status as ReturnStatus])
    return;
  // CLOSED after a refund is just Shopify finalising — keep REFUNDED as the meaningful state.
  if (next === "CLOSED" && rr.status === "REFUNDED") {
    await db.returnRequest.update({
      where: { id: rr.id },
      data: { closedAt: new Date() },
    });
    return;
  }

  await db.returnRequest.update({
    where: { id: rr.id },
    data: {
      status: next,
      ...(next === "APPROVED" ? { approvedAt: new Date() } : {}),
      ...(["CLOSED", "DECLINED", "CANCELED"].includes(next)
        ? { closedAt: new Date() }
        : {}),
      ...(payload.decline
        ? {
            declineReason: payload.decline.reason?.toUpperCase(),
            declineNote: payload.decline.note,
          }
        : {}),
    },
  });
  await logEvent(
    rr.id,
    next,
    `Status changed to ${STATUS_LABELS[next]} in Shopify.`,
    "shopify",
  );
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

const hours = (from: Date, to: Date) => (to.getTime() - from.getTime()) / 36e5;
const avg = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

export async function getAnalytics(shop: string, days = 30) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const returns = await db.returnRequest.findMany({
    where: { shop, requestedAt: { gte: since } },
    include: { items: true },
    orderBy: { requestedAt: "asc" },
  });

  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<
    ReturnStatus,
    number
  >;
  const reasons = new Map<string, number>();
  const products = new Map<string, { units: number; value: number }>();
  const daily = new Map<string, number>();

  for (let d = 0; d < days; d++) {
    const day = new Date(since.getTime() + (d + 1) * 864e5)
      .toISOString()
      .slice(0, 10);
    daily.set(day, 0);
  }

  for (const r of returns) {
    byStatus[r.status as ReturnStatus]++;
    const day = r.requestedAt.toISOString().slice(0, 10);
    daily.set(day, (daily.get(day) ?? 0) + 1);
    for (const item of r.items) {
      reasons.set(
        item.reasonName,
        (reasons.get(item.reasonName) ?? 0) + item.quantity,
      );
      const p = products.get(item.title) ?? { units: 0, value: 0 };
      p.units += item.quantity;
      p.value += item.quantity * item.unitPrice;
      products.set(item.title, p);
    }
  }

  const refunded = returns.filter((r) => r.refundedAt);
  const currency = returns.find((r) => r.currencyCode)?.currencyCode ?? "USD";

  return {
    days,
    currency,
    total: returns.length,
    open:
      byStatus.REQUESTED +
      byStatus.APPROVED +
      byStatus.LABEL_SENT +
      byStatus.RECEIVED,
    awaitingReview: byStatus.REQUESTED,
    byStatus,
    refundedTotal: refunded.reduce((sum, r) => sum + (r.refundAmount ?? 0), 0),
    labelSpend: returns.reduce((sum, r) => sum + (r.labelCost ?? 0), 0),
    avgHoursToApprove: avg(
      returns
        .filter((r) => r.approvedAt)
        .map((r) => hours(r.requestedAt, r.approvedAt!)),
    ),
    avgHoursToRefund: avg(
      refunded.map((r) => hours(r.requestedAt, r.refundedAt!)),
    ),
    reasons: [...reasons.entries()]
      .map(([name, units]) => ({ name, units }))
      .sort((a, b) => b.units - a.units),
    topProducts: [...products.entries()]
      .map(([title, p]) => ({ title, ...p }))
      .sort((a, b) => b.units - a.units)
      .slice(0, 5),
    daily: [...daily.entries()].map(([date, count]) => ({ date, count })),
  };
}
