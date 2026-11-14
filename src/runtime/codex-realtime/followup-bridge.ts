import { Channel } from "@tauri-apps/api/core";
import {
  sessionRealtimeConnect,
  sessionRealtimeDisconnect,
  sessionRealtimeSend,
} from "../../bindings/tauri-commands";
import {
  type ConversationPart,
  type FollowupTransport,
  generateFollowup,
} from "./temporary-followup";

/** 音声の切断後も一時 thread の中断を完了できる、同じ app-server への短命な接続。 */
export async function generateSessionFollowup(
  sessionId: string,
  threadId: string,
  parts: readonly ConversationPart[],
  signal: AbortSignal,
) {
  if (signal.aborted) throw new Error("followup_cancelled");
  let connectionId: string | null = null;
  let nextId = 1;
  const listeners = new Set<(message: Record<string, unknown>) => boolean>();
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (reason: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  // timeout 後も start の相関 ID を短時間保持し、遅れた受領を後始末に使う。
  const lateStarts = new Map<number, { method: string; params: Record<string, unknown> }>();
  const drain: { finish: (() => void) | null } = { finish: null };
  const channel = new Channel<string>();
  channel.onmessage = (raw) => {
    // 大きな設定や無関係の通知も、そのまま JSON 化して保持しない。設定取得は fail-closed。
    if (raw.length > 262_144 || new TextEncoder().encode(raw).length > 262_144) {
      for (const listener of listeners) listener({ method: "yorishiro/followup/overflow" });
      return;
    }
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;
    if (typeof message.id === "number" && typeof message.method !== "string") {
      const request = pending.get(message.id);
      if (!request) {
        const late = lateStarts.get(message.id);
        if (!late) return;
        lateStarts.delete(message.id);
        for (const listener of listeners)
          listener({
            method: "yorishiro/followup/late-start",
            params: { ...late, result: message.error ? null : message.result },
          });
        if (lateStarts.size === 0) drain.finish?.();
        return;
      }
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error("followup_rpc_rejected"));
      else request.resolve(message.result);
      return;
    }
    if (message.method === "yorishiro/realtime-bridge/closed") {
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("followup_connection_closed"));
      }
      pending.clear();
    }
    for (const listener of listeners) if (listener(message)) break;
  };
  const send = (message: object) => {
    if (!connectionId) return Promise.reject(new Error("followup_connection_closed"));
    return sessionRealtimeSend({ connectionId, message: JSON.stringify(message) });
  };
  const transport: FollowupTransport = {
    request: (method, params) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          if (method === "thread/start" || method === "turn/start")
            lateStarts.set(id, { method, params });
          reject(new Error("followup_rpc_timeout"));
        }, 15_000);
        pending.set(id, { resolve, reject, timer });
        void send({ id, method, params }).catch(() => {
          clearTimeout(timer);
          pending.delete(id);
          reject(new Error("followup_connection_closed"));
        });
      }),
    drainStarts: async () => {
      if (lateStarts.size === 0) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          drain.finish = null;
          resolve();
        }, 15_000);
        drain.finish = () => {
          clearTimeout(timer);
          drain.finish = null;
          resolve();
        };
      });
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    rejectInteraction: (id) => {
      void send({
        id,
        error: { code: -32601, message: "Interaction is disabled for this isolated request." },
      }).catch(() => {});
    },
  };
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  let abandoned = false;
  const connect = sessionRealtimeConnect({ sessionId, onMessage: channel }).then(async (id) => {
    if (abandoned) {
      await sessionRealtimeDisconnect({ connectionId: id }).catch(() => {});
      throw new Error("followup_cancelled");
    }
    return id;
  });
  try {
    connectionId = await Promise.race([
      connect,
      new Promise<never>((_, reject) => {
        connectTimer = setTimeout(() => {
          abandoned = true;
          reject(new Error("followup_connect_timeout"));
        }, 15_000);
      }),
    ]);
    if (signal.aborted) throw new Error("followup_cancelled");
    const initialized = await transport.request("initialize", {
      clientInfo: { name: "yorishiro-voice-followup", version: "1" },
      capabilities: { experimentalApi: true },
    });
    if (
      !initialized ||
      typeof initialized !== "object" ||
      !("userAgent" in initialized) ||
      typeof initialized.userAgent !== "string" ||
      !/^codex_cli_rs\/0\.169\.0(?:\s|$)/.test(initialized.userAgent)
    )
      throw new Error("followup_unsupported_version");
    await send({ method: "initialized", params: {} });
    if (signal.aborted) throw new Error("followup_cancelled");
    return await generateFollowup(transport, threadId, parts, signal);
  } finally {
    abandoned = true;
    if (connectTimer !== undefined) clearTimeout(connectTimer);
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("followup_connection_closed"));
    }
    pending.clear();
    lateStarts.clear();
    drain.finish?.();
    listeners.clear();
    if (connectionId) await sessionRealtimeDisconnect({ connectionId }).catch(() => {});
  }
}
