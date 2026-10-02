import { STATUS_LABELS, type ReturnStatus } from "../lib/returns";

const TONES: Record<
  ReturnStatus,
  "info" | "success" | "warning" | "critical" | "neutral" | "caution"
> = {
  REQUESTED: "warning",
  APPROVED: "info",
  LABEL_SENT: "info",
  RECEIVED: "caution",
  REFUNDED: "success",
  CLOSED: "neutral",
  DECLINED: "critical",
  CANCELED: "neutral",
};

export function StatusBadge({ status }: { status: string }) {
  const s = status as ReturnStatus;
  return (
    <s-badge tone={TONES[s] ?? "neutral"}>{STATUS_LABELS[s] ?? status}</s-badge>
  );
}
