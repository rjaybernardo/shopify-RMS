import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  syncReturnFromWebhook,
  type ReturnWebhookPayload,
} from "../services/returns.server";

// Keeps local returns in sync when they change in Shopify (including returns
// created or approved directly in the Shopify admin).
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);
  await syncReturnFromWebhook(shop, topic, payload as ReturnWebhookPayload);

  return new Response();
};
