import { useEffect, useState } from "react";
import type { WorkspaceAttentionStore } from "../runtime/workspace-attention";
import { toSidebarItems, type WorkspaceSidebarItem } from "./workspace-sidebar-items";

interface WorkspaceSidebarProps {
  readonly store: WorkspaceAttentionStore;
  /** session id → 表示ラベル。見つからなければ id をそのまま表示。 */
  readonly labels: ReadonlyMap<string, string>;
}

/**
 * 今 open な attention item（失敗 / 遅延完了 / 実行中）を控えめに並べる sidebar。
 *
 * AttentionItemStore の active items projection を読むだけの observation-only な component。
 * PTY には一切書かない。item が無いときは何も出さない（家の気配であって管制室 dashboard
 * ではない＝presence over spectacle）。
 */
export default function WorkspaceSidebar({ store, labels }: WorkspaceSidebarProps) {
  const [items, setItems] = useState<ReadonlyArray<WorkspaceSidebarItem>>(() =>
    toSidebarItems(store.getActiveItems()),
  );

  useEffect(() => {
    // subscribe は即座に現在 snapshot を渡す契約なので初期 state とも整合する。
    const sub = store.subscribe((snapshot) => {
      setItems(toSidebarItems(snapshot.activeItems));
    });
    return () => {
      sub.dispose();
    };
  }, [store]);

  // 何も open でなければ気配を消す（邪魔しない）。
  if (items.length === 0) return null;

  return (
    <aside className="workspace-sidebar" aria-label="今 気にかけていること">
      <ul className="workspace-sidebar-list">
        {items.map((item) => {
          const sessionLabel = labels.get(item.sessionId) ?? item.sessionId;
          return (
            <li
              key={item.id}
              className={`workspace-sidebar-item severity-${item.severity}`}
              title={item.detailText ?? item.label}
            >
              <span className="workspace-sidebar-dot" aria-hidden="true" />
              <span className="workspace-sidebar-label">{item.label}</span>
              <span className="workspace-sidebar-session">{sessionLabel}</span>
              {item.detailText ? (
                <span className="workspace-sidebar-detail">{item.detailText}</span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
