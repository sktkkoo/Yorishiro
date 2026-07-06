/**
 * command run 完了時の生理反射判定。
 *
 * 長時間 run の完了は成功・失敗どちらも「ターミナルを見る」だけに留める。
 * 表情や照明の valence は workspace-attention 側が別チャネルで扱う。
 */

export interface CommandRunReflexEvent {
  readonly exitCode: number | null;
  readonly durationMs: number | null;
}

export function shouldNotifyAttentionShiftForCommandRun(
  event: CommandRunReflexEvent,
  slowThresholdMs: number,
): boolean {
  return (
    event.exitCode !== null && event.durationMs !== null && event.durationMs >= slowThresholdMs
  );
}
