/**
 * Session tab keybindings。capture phase で xterm より先に捕捉する。
 */

import type { SessionTabManager } from "./session-tab-manager";

function consume(e: KeyboardEvent): void {
  e.preventDefault();
  e.stopPropagation();
}

/**
 * document に capture phase の keydown listener を張る。
 * 戻り値は cleanup 関数（useEffect の return に渡す）。
 */
export function installTabKeybindings(manager: SessionTabManager): () => void {
  const handler = (e: KeyboardEvent) => {
    // Cmd+T: 新しい shell タブ
    if (e.metaKey && !e.shiftKey && !e.ctrlKey && e.key === "t") {
      consume(e);
      manager.openShell(null);
      return;
    }

    // Cmd+W: アクティブタブを閉じる（main は manager 側で弾く）
    if (e.metaKey && !e.shiftKey && !e.ctrlKey && e.key === "w") {
      consume(e);
      manager.close(manager.getState().activeSessionId);
      return;
    }

    // Control+Tab / Control+Shift+Tab: 次/前
    if (e.ctrlKey && !e.metaKey && e.key === "Tab") {
      consume(e);
      if (e.shiftKey) {
        manager.switchPrev();
      } else {
        manager.switchNext();
      }
      return;
    }

    // Cmd+1〜9: N 番目のタブ
    if (e.metaKey && !e.ctrlKey && e.key >= "1" && e.key <= "9") {
      consume(e);
      manager.switchToIndex(Number(e.key) - 1);
      return;
    }
  };

  document.addEventListener("keydown", handler, true);
  return () => document.removeEventListener("keydown", handler, true);
}
