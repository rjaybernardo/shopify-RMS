import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { renderLabelPdf } from "../services/shipping.server";

// Public, unguessable URL for sandbox return labels. Shopify fetches this when the
// label is attached to the reverse delivery, and customers open it from their email.
export const loader = async ({ params }: LoaderFunctionArgs) => {
  const rr = await db.returnRequest.findUnique({
    where: { labelToken: params.token },
  });
  if (!rr?.trackingNumber) throw new Response("Not found", { status: 404 });

  const pdf = renderLabelPdf([
    { text: "RETURN SHIPPING LABEL", size: 22 },
    { text: `${rr.carrier ?? "Carrier"}  -  PREPAID`, size: 14 },
    { text: " " },
    { text: "FROM:", size: 10 },
    { text: rr.customerName ?? "Customer", size: 14 },
    { text: " " },
    { text: "TO:", size: 10 },
    {
      text: rr.shop.replace(".myshopify.com", "").toUpperCase() + " RETURNS",
      size: 16,
    },
    { text: " " },
    { text: `Reference: ${rr.returnName ?? rr.orderName}`, size: 14 },
    { text: `Tracking: ${rr.trackingNumber}`, size: 18 },
    { text: " " },
    { text: "SANDBOX LABEL - NOT VALID FOR POSTAGE", size: 10 },
  ]);

  return new Response(pdf, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="return-label-${rr.trackingNumber}.pdf"`,
      "Cache-Control": "private, max-age=3600",
    },
  });
};
