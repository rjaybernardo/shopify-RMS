// Transactional email. Sends through Resend when RESEND_API_KEY is set,
// otherwise logs the message so the flow is observable in development.

type Email = { to: string; subject: string; html: string };

export async function sendEmail({ to, subject, html }: Email) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || "Returns <returns@example.com>";

  if (!apiKey) {
    console.log(`[email] to=${to} subject="${subject}"`);
    return { delivered: false };
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to, subject, html }),
    });
    if (!response.ok) {
      console.error(
        `[email] Resend error ${response.status}: ${await response.text()}`,
      );
    }
    return { delivered: response.ok };
  } catch (error) {
    // Email must never block a return from progressing.
    console.error("[email] send failed", error);
    return { delivered: false };
  }
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const layout = (title: string, body: string) => `
  <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a">
    <h2 style="margin:0 0 16px">${escapeHtml(title)}</h2>
    ${body}
    <p style="color:#6b6b6b;font-size:13px;margin-top:32px">Reply to this email if you have any questions about your return.</p>
  </div>`;

export const templates = {
  requested: (orderName: string, returnName: string) => ({
    subject: `We received your return request for ${orderName}`,
    html: layout(
      "Return request received",
      `<p>Your return <strong>${escapeHtml(returnName)}</strong> for order ${escapeHtml(orderName)} is being reviewed. We'll email you a prepaid shipping label as soon as it's approved.</p>`,
    ),
  }),
  approved: (
    orderName: string,
    label: { labelUrl: string; trackingNumber: string; carrier: string },
  ) => ({
    subject: `Your return label for ${orderName}`,
    html: layout(
      "Your return is approved",
      `<p>Print the prepaid label below, attach it to your package and drop it off with ${escapeHtml(label.carrier)}.</p>
       <p><a href="${escapeHtml(label.labelUrl)}" style="display:inline-block;background:#1a1a1a;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Download return label</a></p>
       <p>Tracking number: <strong>${escapeHtml(label.trackingNumber)}</strong></p>`,
    ),
  }),
  declined: (orderName: string, note?: string | null) => ({
    subject: `Update on your return for ${orderName}`,
    html: layout(
      "We couldn't approve your return",
      `<p>Unfortunately your return request for ${escapeHtml(orderName)} was declined.</p>${
        note ? `<p>${escapeHtml(note)}</p>` : ""
      }`,
    ),
  }),
  refunded: (orderName: string, amount: string) => ({
    subject: `Your refund for ${orderName} is on its way`,
    html: layout(
      "Refund issued",
      `<p>We received your returned items and refunded <strong>${escapeHtml(amount)}</strong> to your original payment method. It can take 5–10 business days to appear on your statement.</p>`,
    ),
  }),
  merchantNewReturn: (
    orderName: string,
    itemCount: number,
    adminUrl: string,
  ) => ({
    subject: `New return request on ${orderName}`,
    html: layout(
      "New return request",
      `<p>A customer requested a return of ${itemCount} item(s) on ${escapeHtml(orderName)}.</p><p><a href="${escapeHtml(adminUrl)}">Review it in the Returns app</a></p>`,
    ),
  }),
};
