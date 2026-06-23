import type {
  WorkspaceAttentionItem,
  WorkspaceAttentionItemType,
  WorkspaceAttentionSeverity,
} from "../runtime/workspace-attention";

/**
 * Sidebar に並べる 1 行ぶんの表示 item。
 * AttentionItem を「読むためだけ」の形に畳んだ純データで、表示以外の責務は持たない。
 */
export interface WorkspaceSidebarItem {
  readonly id: string;
  readonly sessionId: string;
  readonly type: WorkspaceAttentionItemType;
  readonly severity: WorkspaceAttentionSeverity;
  /** type に対応する人間向けの短いラベル。 */
  readonly label: string;
  /** 補足テキスト（実行された command 等）。取り出せないときは undefined。 */
  readonly detailText?: string;
}

/** type → 日本語の短いラベル。家の気配なので最小限の語に留める。 */
const LABEL_BY_TYPE: Record<WorkspaceAttentionItemType, string> = {
  "run-failed": "失敗",
  "run-slow-completed": "遅延完了",
  "run-running-long": "実行中",
};

/** severity を並び順スコアに写す。high が上に来る。 */
const SEVERITY_RANK: Record<WorkspaceAttentionSeverity, number> = {
  low: 1,
  medium: 2,
  high: 3,
};

/**
 * AttentionItemStore の active items projection を sidebar 表示 item に変換する。
 *
 * - active 以外の state は防御的に除外する（store は active のみを渡す前提だが、
 *   呼び出し元の取り回しに依存しないようここでも畳む）。
 * - severity が高い順、同 severity なら新しい順（createdAt 降順）に並べる。
 *   これは primary item の選定（severity × age）と整合する直感的な並びにするため。
 */
export function toSidebarItems(
  items: ReadonlyArray<WorkspaceAttentionItem>,
): ReadonlyArray<WorkspaceSidebarItem> {
  return items
    .filter((item) => item.state === "active")
    .slice()
    .sort((a, b) => {
      const severityDiff = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
      if (severityDiff !== 0) return severityDiff;
      return b.createdAt - a.createdAt;
    })
    .map((item) => ({
      id: item.id,
      sessionId: item.sessionId,
      type: item.type,
      severity: item.severity,
      label: LABEL_BY_TYPE[item.type],
      detailText: extractCommand(item.detail),
    }));
}

/**
 * detail から command 文字列だけを安全に取り出す。
 * detail は producer ごとに形が違う unknown なので型ガードで防御する。
 */
function extractCommand(detail: unknown): string | undefined {
  if (typeof detail !== "object" || detail === null) return undefined;
  const command = (detail as { command?: unknown }).command;
  return typeof command === "string" && command.length > 0 ? command : undefined;
}
