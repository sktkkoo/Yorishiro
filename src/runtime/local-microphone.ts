/** ローカル入力だけを制御する。住人の発話・相手の音声再生とは独立した経路。 */
export interface LocalMicrophoneAdapter {
  readonly transportId: string;
  readonly connection: "idle" | "connecting" | "active" | "error";
  readonly muted: boolean;
  readonly captureActive: boolean;
  readonly interrupted: boolean;
  setMuted(muted: boolean): void;
}

export type LocalMicrophoneStatus =
  | "disconnected"
  | "connecting"
  | "sending"
  | "muted"
  | "interrupted"
  | "error";

/** 将来の会議 adapter も同じ host 制御に接続し、UI やキー操作を個別に持たない。 */
export function createLocalMicrophoneControl(adapter: LocalMicrophoneAdapter) {
  const connected = adapter.connection === "active";
  const sending = connected && adapter.captureActive && !adapter.muted && !adapter.interrupted;
  const status: LocalMicrophoneStatus = !connected
    ? adapter.connection === "idle"
      ? "disconnected"
      : adapter.connection
    : adapter.interrupted
      ? "interrupted"
      : adapter.muted
        ? "muted"
        : sending
          ? "sending"
          : "interrupted";
  return {
    transportId: adapter.transportId,
    connected,
    muted: adapter.muted,
    sending,
    status,
    setMuted: (muted: boolean) => adapter.setMuted(muted),
    toggleMute: () => {
      if (connected) adapter.setMuted(!adapter.muted);
    },
  };
}

export type LocalMicrophoneControl = ReturnType<typeof createLocalMicrophoneControl>;

/** 表示モード・音声 transport に依存しない、アプリにフォーカスがある間の操作。 */
export function installMicrophoneMuteShortcut({
  macos,
  getControl,
  target = window,
}: {
  readonly macos: boolean;
  readonly getControl: () => LocalMicrophoneControl;
  readonly target?: Pick<Window, "addEventListener" | "removeEventListener">;
}): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.repeat ||
      event.isComposing ||
      event.code !== "KeyM" ||
      !event.shiftKey ||
      event.altKey ||
      event.metaKey !== macos ||
      event.ctrlKey === macos
    )
      return;
    const control = getControl();
    if (!control.connected) return;
    event.preventDefault();
    event.stopPropagation();
    control.toggleMute();
  };
  // xterm / editor が bubble 段階でキーを消費する前に、アプリ共通操作を処理する。
  target.addEventListener("keydown", onKeyDown as EventListener, true);
  return () => target.removeEventListener("keydown", onKeyDown as EventListener, true);
}
