import { createModels } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { credentialMetadata, PiCredentialStore } from "./credential-store.mjs";

/** Local metadata only: no store creation, credential refresh or model call. */
export function authStatus(authPath, dependencies = {}) {
  const provider = (dependencies.provider ?? openaiProvider)();
  const models = provider.getModels().map(({ id, name }) => ({ id, name: name ?? id }));
  let authenticated = false;
  let authentication = "missing";
  try {
    const metadata = (dependencies.metadata ?? credentialMetadata)(authPath);
    authenticated = metadata.present && metadata.type === "oauth";
    authentication = authenticated ? "present" : metadata.present ? "invalid" : "missing";
  } catch {
    authentication = "invalid";
  }
  return { protocol: 1, type: "auth_status", authenticated, authentication, models };
}

export function officialAuthUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "auth.openai.com" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/api/accounts/authorize" &&
      url.hash === "" &&
      url.searchParams.getAll("redirect_uri").length === 1 &&
      url.searchParams.get("redirect_uri") === "http://127.0.0.1:1455/auth/callback" &&
      url.searchParams.getAll("response_type").length === 1 &&
      url.searchParams.get("response_type") === "code"
    );
  } catch {
    return false;
  }
}

function callbackOnly(prompt, signal) {
  if (prompt.type !== "manual_code") return Promise.reject(new Error("login_prompt_invalid"));
  const cancellation = prompt.signal ?? signal;
  return new Promise((_, reject) => {
    if (cancellation?.aborted) {
      reject(new Error("login_cancelled"));
      return;
    }
    cancellation?.addEventListener("abort", () => reject(new Error("login_cancelled")), {
      once: true,
    });
  });
}

/** Explicit OAuth only. Nothing returned to IPC contains credential values. */
export async function loginWithPi({ authPath, signal, emit }, dependencies = {}) {
  const store = (dependencies.store ?? ((path) => new PiCredentialStore(path)))(authPath);
  let models;
  try {
    signal?.throwIfAborted();
    const deviceId = await store.deviceId({ signal });
    models = (dependencies.models ?? createModels)({
      credentials: store,
      authContext: { env: async () => undefined, fileExists: async () => false },
    });
    models.setProvider((dependencies.provider ?? openaiProvider)());
    const credential = await models.login(
      "openai",
      "oauth",
      {
        signal,
        prompt: (prompt) => callbackOnly(prompt, signal),
        notify(event) {
          if (event.type === "auth_url") {
            if (!officialAuthUrl(event.url)) throw new Error("login_url_invalid");
            emit({ type: "auth_url", url: event.url });
          } else if (event.type === "progress") emit({ type: "login_progress" });
        },
      },
      { getDeviceId: () => deviceId, agentName: "Yorishiro" },
    );
    if (credential?.type !== "oauth") throw new Error("login_credential_invalid");
    return { type: "login_result", connected: true };
  } finally {
    // Login resolves only after Models has completed its credential operation.
    try {
      await models?.close?.();
    } finally {
      await store.close();
    }
  }
}
