// Status model and formatting shared by server code and UI.

export const STATUSES = [
  "REQUESTED",
  "APPROVED",
  "LABEL_SENT",
  "RECEIVED",
  "REFUNDED",
  "CLOSED",
  "DECLINED",
  "CANCELED",
] as const;
export type ReturnStatus = (typeof STATUSES)[number];

export const STATUS_LABELS: Record<ReturnStatus, string> = {
  REQUESTED: "Requested",
  APPROVED: "Approved",
  LABEL_SENT: "Label sent",
  RECEIVED: "Received",
  REFUNDED: "Refunded",
  CLOSED: "Closed",
  DECLINED: "Declined",
  CANCELED: "Canceled",
};

export function formatMoney(
  amount: number | null | undefined,
  currency = "USD",
) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
    amount ?? 0,
  );
}
