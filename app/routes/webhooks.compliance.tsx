import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// Mandatory privacy webhooks: customers/data_request, customers/redact, shop/redact.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST":
      // Return data is visible to the merchant in the app; nothing to push externally.
      break;
    case "CUSTOMERS_REDACT": {
      const email = payload.customer?.email as string | undefined;
      const orderIds = ((payload.orders_to_redact ?? []) as number[]).map(
        (id) => `gid://shopify/Order/${id}`,
      );
      await db.returnRequest.updateMany({
        where: {
          shop,
          OR: [
            ...(email ? [{ customerEmail: email }] : []),
            { orderId: { in: orderIds } },
          ],
        },
        data: { customerEmail: "", customerName: null, customerNote: null },
      });
      break;
    }
    case "SHOP_REDACT":
      await db.returnRequest.deleteMany({ where: { shop } });
      await db.shopSettings.deleteMany({ where: { shop } });
      break;
  }

  return new Response();
};
