export type SharingDeliveryMode = "context" | "on-demand";

/** 取得間隔と共有タイミングを、実際の送信方式に合わせて説明する。 */
export function sharingDeliveryLabels(
  deliveryMode: SharingDeliveryMode,
  language: string,
  sourceKind: "screen" | "camera",
) {
  const japanese = language.startsWith("ja");
  if (deliveryMode === "on-demand") {
    return {
      interval: japanese ? "更新間隔" : "Refresh interval",
      hint: japanese
        ? `${sourceKind === "camera" ? "映像" : "画面"}について尋ねると、最新の画像を確認します。`
        : `Ask about the ${sourceKind === "camera" ? "camera view" : "screen"} to share the latest image.`,
    };
  }
  return {
    interval: japanese ? "送信間隔" : "Send interval",
    hint: japanese
      ? "間隔が短いほどトークン消費が増えます。"
      : "Shorter intervals use more tokens.",
  };
}
