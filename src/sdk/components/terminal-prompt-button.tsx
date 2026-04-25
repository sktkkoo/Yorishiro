/**
 * TerminalPromptButton — terminal の PTY に pre-fill prompt を送る共通 component。
 *
 * 改行を含めずに `pty_write` を呼ぶことで、user が Enter を押すまでは実行されない。
 * 設定画面など UI pack の中で「このボタンを押すと住人に相談できる」入口を作るために使う。
 *
 * `closeActiveUiBeforeWrite=true` の時は、書き込み前に active UI pack を閉じて
 * terminal を見える状態にしてから pre-fill する（user が pre-fill された prompt を
 * 確認して Enter を押す flow になる）。
 */

import type React from "react";
import { useState } from "react";

export interface PerformTerminalPromptWriteArgs {
  readonly text: string;
  readonly ptyWrite: (args: { data: string }) => Promise<void>;
  readonly closeActiveUi: (() => void) | undefined;
}

export type PerformResult = { ok: true } | { ok: false; reason: string };

/**
 * pure helper: closeActiveUi → ptyWrite の順で呼ぶ。テスト容易性のため component から分離。
 */
export async function performTerminalPromptWrite(
  args: PerformTerminalPromptWriteArgs,
): Promise<PerformResult> {
  if (args.closeActiveUi) {
    args.closeActiveUi();
  }
  try {
    await args.ptyWrite({ data: args.text });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export interface TerminalPromptButtonProps {
  /** pre-fill する文字列（改行なし、user が Enter）。 */
  readonly text: string;
  /** ボタン表示。 */
  readonly label: string;
  /**
   * クリック時に active UI pack を閉じてから pre-fill する。
   * 設定画面の中で使う場合は true 推奨。
   * default: false
   */
  readonly closeActiveUiBeforeWrite?: boolean;
  /** 失敗時の callback。reason は dev log / console.error 用。 */
  readonly onError?: (reason: string) => void;
  /**
   * pty_write の wrapper。Tauri 環境では `import { ptyWrite } from "@/bindings/tauri-commands"`
   * を渡す。テストでは mock を渡す。
   */
  readonly ptyWrite: (args: { data: string }) => Promise<void>;
  /**
   * active UI pack を閉じる callback。`closeActiveUiBeforeWrite=true` の時のみ参照される。
   */
  readonly closeActiveUi?: () => void;
  readonly style?: React.CSSProperties;
  readonly className?: string;
}

export function TerminalPromptButton(props: TerminalPromptButtonProps): React.JSX.Element {
  const [pending, setPending] = useState(false);

  const onClick = async () => {
    if (pending) return;
    setPending(true);
    try {
      const result = await performTerminalPromptWrite({
        text: props.text,
        ptyWrite: props.ptyWrite,
        closeActiveUi: props.closeActiveUiBeforeWrite ? props.closeActiveUi : undefined,
      });
      if (!result.ok) {
        console.error("[TerminalPromptButton] pty_write failed:", result.reason);
        props.onError?.(result.reason);
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      style={props.style}
      className={props.className}
    >
      {props.label}
    </button>
  );
}
