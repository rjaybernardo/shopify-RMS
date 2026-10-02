import crypto from "node:crypto";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  createPortalReturn,
  getSettings,
  isWithinReturnWindow,
} from "../services/returns.server";
import {
  findOrderByName,
  getReturnableItems,
  type ReturnableItem,
  type ReturnReason,
} from "../services/shopify-returns.server";
import { formatMoney } from "../lib/returns";

// Customer return portal, reached at https://{shop}/apps/returns via the app proxy
// configured in shopify.app.toml. Responses are Liquid so the page renders inside
// the merchant's theme. A short-lived HMAC token carries the verified order between
// steps so a customer can only ever submit items for the order they looked up.

const PORTAL_PATH = "/apps/returns";
const TOKEN_TTL_MS = 30 * 60 * 1000;

// Escapes HTML and neutralises Liquid delimiters in any customer- or shop-provided text.
const esc = (value: unknown) =>
  String(value ?? "").replace(/[&<>"'{}%]/g, (c) => `&#${c.charCodeAt(0)};`);

function sign(payload: string) {
  return crypto
    .createHmac("sha256", process.env.SHOPIFY_API_SECRET || "dev-secret")
    .update(payload)
    .digest("base64url");
}

function issueToken(shop: string, orderId: string) {
  const payload = Buffer.from(
    JSON.stringify({ shop, orderId, exp: Date.now() + TOKEN_TTL_MS }),
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function readToken(token: string, shop: string) {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = sign(payload);
  if (
    expected.length !== signature.length ||
    !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  ) {
    return null;
  }
  const data = JSON.parse(Buffer.from(payload, "base64url").toString());
  return data.shop === shop && data.exp > Date.now()
    ? (data.orderId as string)
    : null;
}

const styles = `
<style>
  .rma{max-width:720px;margin:40px auto;padding:0 16px;font-family:inherit}
  .rma h1{margin-bottom:8px}
  .rma .muted{opacity:.7}
  .rma form{display:grid;gap:16px;margin-top:24px}
  .rma label{display:grid;gap:6px;font-weight:600}
  .rma input,.rma select,.rma textarea{padding:10px 12px;border:1px solid rgba(0,0,0,.25);border-radius:8px;font:inherit;font-weight:400}
  .rma .item{display:grid;grid-template-columns:64px 1fr;gap:16px;padding:16px;border:1px solid rgba(0,0,0,.12);border-radius:12px}
  .rma .item img,.rma .item .ph{width:64px;height:64px;object-fit:cover;border-radius:8px;background:rgba(0,0,0,.06)}
  .rma .item .fields{display:none;gap:12px;margin-top:12px;grid-template-columns:120px 1fr}
  .rma .item.on .fields{display:grid}
  .rma .item .note{grid-column:1/-1}
  .rma .check{display:flex;gap:10px;align-items:center;font-weight:600}
  .rma .error{padding:12px 16px;border-radius:8px;background:#fdecea;color:#8a1c12}
  .rma .ok{padding:16px;border-radius:12px;background:#e8f5ee;color:#0b5132}
  .rma button{padding:12px 20px;border:0;border-radius:8px;background:#111;color:#fff;font:inherit;font-weight:600;cursor:pointer;justify-self:start}
</style>`;

function page(body: string) {
  return `${styles}<div class="rma">${body}</div>`;
}

function lookupPage(
  intro: string,
  error?: string,
  values?: { order?: string; email?: string },
) {
  return page(`
    <h1>Start a return</h1>
    <p class="muted">${esc(intro)}</p>
    ${error ? `<p class="error">${esc(error)}</p>` : ""}
    <form method="post" action="${PORTAL_PATH}">
      <input type="hidden" name="intent" value="lookup">
      <label>Order number<input name="order" placeholder="#1001" required value="${esc(values?.order)}"></label>
      <label>Email used at checkout<input type="email" name="email" required value="${esc(values?.email)}"></label>
      <button type="submit">Find my order</button>
    </form>`);
}

function selectPage(
  orderName: string,
  token: string,
  items: ReturnableItem[],
  reasons: ReturnReason[],
  error?: string,
) {
  const reasonOptions = reasons
    .map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`)
    .join("");

  const rows = items
    .map((item, i) => {
      const qtyOptions = Array.from(
        { length: item.quantity },
        (_, q) => `<option>${q + 1}</option>`,
      ).join("");
      return `
      <div class="item" data-item>
        ${item.imageUrl ? `<img src="${esc(item.imageUrl)}" alt="">` : `<div class="ph"></div>`}
        <div>
          <label class="check">
            <input type="checkbox" name="item_${i}_selected" data-toggle>
            ${esc(item.title)}
          </label>
          <div class="muted">${esc(item.variantTitle ?? "")} ${formatMoney(item.unitPrice, item.currencyCode)}</div>
          <input type="hidden" name="item_${i}_id" value="${esc(item.fulfillmentLineItemId)}">
          <div class="fields">
            <label>Quantity<select name="item_${i}_qty">${qtyOptions}</select></label>
            <label>Reason<select name="item_${i}_reason"><option value="">Choose a reason</option>${reasonOptions}</select></label>
            <label class="note">Anything we should know? (optional)<textarea name="item_${i}_note" rows="2" maxlength="300"></textarea></label>
          </div>
        </div>
      </div>`;
    })
    .join("");

  return page(`
    <h1>Return items from ${esc(orderName)}</h1>
    <p class="muted">Select the items you'd like to send back. We'll email you a prepaid label once your return is approved.</p>
    ${error ? `<p class="error">${esc(error)}</p>` : ""}
    ${
      items.length
        ? `<form method="post" action="${PORTAL_PATH}">
            <input type="hidden" name="intent" value="submit">
            <input type="hidden" name="token" value="${esc(token)}">
            <input type="hidden" name="count" value="${items.length}">
            ${rows}
            <button type="submit">Submit return request</button>
          </form>
          <script>
            document.querySelectorAll('[data-item]').forEach(function (el) {
              el.querySelector('[data-toggle]').addEventListener('change', function (e) {
                el.classList.toggle('on', e.target.checked);
              });
            });
          </script>`
        : `<p class="error">There are no items left to return on this order.</p>`
    }`);
}

function confirmationPage(returnName: string, email: string) {
  return page(`
    <h1>Return requested</h1>
    <div class="ok">
      <p><strong>${esc(returnName)}</strong> has been submitted.</p>
      <p>We sent a confirmation to ${esc(email)}. You'll receive your prepaid return label by email once it's approved.</p>
    </div>`);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { liquid, session } = await authenticate.public.appProxy(request);
  if (!session)
    return liquid(page("<p>Returns are not available right now.</p>"));
  const settings = await getSettings(session.shop);
  return liquid(lookupPage(settings.portalIntro));
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { liquid, session, admin } =
    await authenticate.public.appProxy(request);
  if (!session || !admin)
    return liquid(page("<p>Returns are not available right now.</p>"));

  const shop = session.shop;
  const settings = await getSettings(shop);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "lookup") {
    const orderInput = String(form.get("order") ?? "").trim();
    const email = String(form.get("email") ?? "")
      .trim()
      .toLowerCase();
    const order = orderInput ? await findOrderByName(admin, orderInput) : null;

    // Same message for "no order" and "wrong email" so order numbers can't be enumerated.
    if (!order || order.email?.toLowerCase() !== email) {
      return liquid(
        lookupPage(
          settings.portalIntro,
          "We couldn't find an order matching those details.",
          {
            order: orderInput,
            email,
          },
        ),
      );
    }
    if (!isWithinReturnWindow(order, settings.returnWindowDays)) {
      return liquid(
        lookupPage(
          settings.portalIntro,
          `This order is outside our ${settings.returnWindowDays}-day return window.`,
        ),
      );
    }

    const { items, reasons } = await getReturnableItems(admin, order.id);
    return liquid(
      selectPage(order.name, issueToken(shop, order.id), items, reasons),
    );
  }

  if (intent === "submit") {
    const token = String(form.get("token") ?? "");
    const orderId = readToken(token, shop);
    if (!orderId) {
      return liquid(
        lookupPage(
          settings.portalIntro,
          "Your session expired. Please look up your order again.",
        ),
      );
    }

    const { items, reasons } = await getReturnableItems(admin, orderId);
    const count = Math.min(Number(form.get("count")) || 0, 100);
    const selections = Array.from({ length: count }, (_, i) => ({
      selected: form.get(`item_${i}_selected`) === "on",
      fulfillmentLineItemId: String(form.get(`item_${i}_id`) ?? ""),
      quantity: Number(form.get(`item_${i}_qty`)) || 1,
      reasonId: String(form.get(`item_${i}_reason`) ?? ""),
      note: String(form.get(`item_${i}_note`) ?? "").trim(),
    })).filter((s) => s.selected);

    // Order name/email for display and records come from Shopify, not the form.
    const orderNode = await admin.graphql(
      `#graphql
      query RmaPortalOrder($id: ID!) {
        order(id: $id) { id name email processedAt currencyCode customer { id displayName } }
      }`,
      { variables: { id: orderId } },
    );
    const order = (await orderNode.json()).data.order;

    if (!selections.length || selections.some((s) => !s.reasonId)) {
      return liquid(
        selectPage(
          order.name,
          token,
          items,
          reasons,
          "Select at least one item and choose a reason for each.",
        ),
      );
    }

    try {
      const rr = await createPortalReturn({
        admin,
        shop,
        order,
        selections,
        returnable: items,
        reasons,
      });
      return liquid(
        confirmationPage(rr.returnName ?? order.name, order.email ?? ""),
      );
    } catch (error) {
      console.error("[portal] return request failed", error);
      return liquid(
        selectPage(order.name, token, items, reasons, (error as Error).message),
      );
    }
  }

  return liquid(lookupPage(settings.portalIntro));
};
