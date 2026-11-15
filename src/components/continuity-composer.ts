import { useCallback, useEffect, useSyncExternalStore } from "react";
import { sendContinuityMessage } from "../runtime/continuity/client";
import type { ContinuityContext } from "../runtime/continuity/types";
import {
  activeContinuityInput,
  type ContinuityInput,
  finishContinuityInput,
  readContinuityInput,
  serializeContinuityInput,
} from "./continuity-input";

interface ComposerState {
  readonly input: ContinuityInput;
  readonly sending: boolean;
  readonly error: string | null;
}
interface ComposerOwner {
  readonly key: string;
  readonly listeners: Set<() => void>;
  state: ComposerState;
  unseenFailure: boolean;
  storageUnavailable: boolean;
}
const owners = new Map<string, ComposerOwner>();
export const continuityComposerIdentity = (id: string) =>
  id === "yori-ja" || id === "yori-en" ? "builtin:yori" : `custom:${id}`;
const storageKey = (key: string) => `yorishiro.continuity.input.${encodeURIComponent(key)}`;

function release(owner: ComposerOwner) {
  // StrictMode の再購読を待ち、未表示の失敗と保存できない下書きは保持する。
  queueMicrotask(() => {
    if (
      owners.get(owner.key) === owner &&
      !owner.listeners.size &&
      !owner.state.sending &&
      !owner.unseenFailure &&
      !owner.storageUnavailable
    )
      owners.delete(owner.key);
  });
}
function ownerFor(key: string): ComposerOwner {
  const existing = owners.get(key);
  if (existing) return existing;
  let input = readContinuityInput(null);
  try {
    input = readContinuityInput(localStorage.getItem(storageKey(key)));
  } catch {
    // 読み込めない空の所有者は保持せず、実際の編集が保存できない場合だけ残す。
  }
  const owner: ComposerOwner = {
    key,
    state: { input, sending: false, error: null },
    listeners: new Set(),
    unseenFailure: false,
    storageUnavailable: false,
  };
  owners.set(key, owner);
  release(owner);
  return owner;
}
function publish(owner: ComposerOwner, state: ComposerState) {
  if (state.input !== owner.state.input) {
    try {
      localStorage.setItem(storageKey(owner.key), serializeContinuityInput(state.input));
      owner.storageUnavailable = false;
    } catch {
      // 保存領域の失敗で送信を妨げず、受理済み下書きの更新はメモリ上に残す。
      owner.storageUnavailable = true;
    }
  }
  owner.state = state;
  for (const listener of owner.listeners) listener();
  release(owner);
}
function submit(owner: ComposerOwner, context: ContinuityContext): Promise<void> | null {
  const submitted = owner.state.input;
  const text = activeContinuityInput(submitted).text.trim();
  if (owner.state.sending || !text) return null;
  owner.unseenFailure = false;
  publish(owner, { ...owner.state, sending: true, error: null });
  return (async () => {
    try {
      await sendContinuityMessage(context, text, submitted.target.id ?? undefined);
      publish(owner, {
        ...owner.state,
        input: finishContinuityInput(owner.state.input, submitted),
        sending: false,
      });
    } catch (cause) {
      owner.unseenFailure = true;
      publish(owner, {
        ...owner.state,
        sending: false,
        error: cause instanceof Error ? cause.message : String(cause),
      });
      throw cause;
    }
  })();
}

export function useContinuityComposer(personaId: string, visible = true) {
  const key = continuityComposerIdentity(personaId);
  const subscribe = useCallback(
    (listener: () => void) => {
      // render 中の参照を再利用せず、commit 時点の所有者へ購読する。
      const owner = ownerFor(key);
      owner.listeners.add(listener);
      return () => {
        owner.listeners.delete(listener);
        release(owner);
      };
    },
    [key],
  );
  const getSnapshot = useCallback(() => ownerFor(key).state, [key]);
  const state = useSyncExternalStore(subscribe, getSnapshot);
  useEffect(() => {
    if (!visible || !state.error) return;
    const owner = ownerFor(key);
    // 非表示の購読や古い描画では、まだ見せていない失敗を消費しない。
    if (owner.state === state) owner.unseenFailure = false;
  }, [key, visible, state]);
  const updateInput = useCallback(
    (update: (input: ContinuityInput) => ContinuityInput) => {
      const owner = ownerFor(key);
      const input = update(owner.state.input);
      if (input !== owner.state.input) publish(owner, { ...owner.state, input });
    },
    [key],
  );
  const send = useCallback((context: ContinuityContext) => submit(ownerFor(key), context), [key]);
  const clearError = useCallback(() => {
    const owner = ownerFor(key);
    owner.unseenFailure = false;
    if (owner.state.error !== null) publish(owner, { ...owner.state, error: null });
  }, [key]);
  return { ...state, updateInput, send, clearError };
}
