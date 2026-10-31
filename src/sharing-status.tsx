import type { SharingDeliveryMode } from "./runtime/sharing-delivery";

interface Props {
  readonly deliveryMode?: SharingDeliveryMode;
  readonly active: boolean;
  readonly busy: boolean;
  readonly lastObservedAt?: number;
  readonly language: string;
}

/** 状態は一か所で示し、送信時刻は補足として確認できるようにする。 */
export function SharingStatus({
  active,
  busy,
  lastObservedAt,
  language,
  deliveryMode = "context",
}: Props) {
  if (!active && !busy) return null;
  const japanese = language.startsWith("ja");
  const timeLabel =
    deliveryMode === "on-demand"
      ? japanese
        ? "最終更新"
        : "Last refreshed"
      : japanese
        ? "最終共有"
        : "Last shared";
  const lastShared =
    lastObservedAt !== undefined && Number.isFinite(lastObservedAt)
      ? new Date(lastObservedAt).toLocaleTimeString(japanese ? "ja-JP" : "en-US")
      : null;
  return (
    <span
      className="screen-sharing-badge"
      data-active={active}
      role="status"
      title={lastShared ? `${timeLabel}: ${lastShared}` : undefined}
    >
      {active ? (japanese ? "共有中" : "Sharing") : japanese ? "準備中…" : "Starting…"}
    </span>
  );
}
