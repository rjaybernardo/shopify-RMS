import { useEffect } from "react";
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
import { getSettings } from "../services/returns.server";
import { getLabelProvider } from "../services/shipping.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return {
    settings: await getSettings(session.shop),
    portalUrl: `https://${session.shop}/apps/returns`,
    labelProvider: getLabelProvider().name,
    emailConfigured: Boolean(process.env.RESEND_API_KEY),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const windowDays = Math.round(Number(form.get("returnWindowDays")));

  if (!Number.isFinite(windowDays) || windowDays < 1 || windowDays > 365) {
    return {
      ok: false,
      message: "Return window must be between 1 and 365 days",
    };
  }

  await db.shopSettings.update({
    where: { shop: session.shop },
    data: {
      returnWindowDays: windowDays,
      autoApprove: form.get("autoApprove") === "on",
      autoRefundOnReceipt: form.get("autoRefundOnReceipt") === "on",
      restockOnReceipt: form.get("restockOnReceipt") === "on",
      notifyMerchantEmail:
        String(form.get("notifyMerchantEmail") || "").trim() || null,
      portalIntro: String(form.get("portalIntro") || "").slice(0, 500),
    },
  });
  return { ok: true, message: "Settings saved" };
};

export default function Settings() {
  const { settings, portalUrl, labelProvider, emailConfigured } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
    }
  }, [fetcher.state, fetcher.data, shopify]);

  return (
    <s-page heading="Settings">
      <fetcher.Form method="post">
        <s-section heading="Return policy">
          <s-stack gap="base">
            <s-number-field
              label="Return window (days)"
              name="returnWindowDays"
              min={1}
              max={365}
              defaultValue={String(settings.returnWindowDays)}
              details="Orders older than this can't start a return in the portal."
            />
            <s-checkbox
              label="Auto-approve requests"
              name="autoApprove"
              defaultChecked={settings.autoApprove}
              details="Approve eligible requests instantly and email the prepaid label."
            />
            <s-checkbox
              label="Refund automatically when items are received"
              name="autoRefundOnReceipt"
              defaultChecked={settings.autoRefundOnReceipt}
              details="Refunds go back to the original payment method."
            />
            <s-checkbox
              label="Restock items when received"
              name="restockOnReceipt"
              defaultChecked={settings.restockOnReceipt}
            />
          </s-stack>
        </s-section>

        <s-section heading="Notifications & portal">
          <s-stack gap="base">
            <s-email-field
              label="Notify this address about new requests"
              name="notifyMerchantEmail"
              defaultValue={settings.notifyMerchantEmail ?? ""}
            />
            <s-text-area
              label="Portal introduction"
              name="portalIntro"
              rows={3}
              maxLength={500}
              defaultValue={settings.portalIntro}
            />
            <s-button
              type="submit"
              variant="primary"
              {...(fetcher.state !== "idle" ? { loading: true } : {})}
            >
              Save
            </s-button>
          </s-stack>
        </s-section>
      </fetcher.Form>

      <s-section slot="aside" heading="Customer return portal">
        <s-stack gap="small-300">
          <s-paragraph>
            Link to this page from your store&apos;s footer or order
            confirmation emails.
          </s-paragraph>
          <s-link href={portalUrl} target="_blank">
            {portalUrl}
          </s-link>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Integrations">
        <s-stack gap="small-300">
          <s-stack direction="inline" justifyContent="space-between">
            <s-text>Shipping labels</s-text>
            <s-badge
              tone={labelProvider === "EasyPost" ? "success" : "warning"}
            >
              {labelProvider}
            </s-badge>
          </s-stack>
          <s-stack direction="inline" justifyContent="space-between">
            <s-text>Email</s-text>
            <s-badge tone={emailConfigured ? "success" : "warning"}>
              {emailConfigured ? "Resend" : "Log only"}
            </s-badge>
          </s-stack>
          <s-text color="subdued">
            Set EASYPOST_API_KEY and RESEND_API_KEY in the app environment to go
            live.
          </s-text>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
