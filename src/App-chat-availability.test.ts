import * as ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import appSource from "./App.tsx?raw";

// Exercise App's actual Chat gates without starting its native/3D runtime.
// The setup-skip shell retains terminalAgent, so provider checks alone are unsafe.
const app = ts.createSourceFile(
  "App.tsx",
  appSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const appFunction = app.statements.find(
  (node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === "App",
);
const gateNames = new Set([
  "mainAgentAvailable",
  "chatPresented",
  "chatSessionStatus",
  "chatApprovals",
  "chatRequiresAttention",
  "chatSupported",
  "chatCanSend",
  "submitChatText",
  "chatConversation",
  "chatStatus",
]);
const gateStatements = appFunction?.body?.statements.filter(
  (node) =>
    ts.isVariableStatement(node) &&
    node.declarationList.declarations.some((declaration) =>
      gateNames.has(declaration.name.getText(app)),
    ),
);
if (gateStatements?.length !== gateNames.size) throw new Error("App's Chat gates were not found");
const gateJs = ts.transpileModule(gateStatements.map((node) => node.getText(app)).join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2020 },
}).outputText;

function setup(kind: "shell" | "agent", terminalAgent: "codex" | "claude") {
  const submit = vi.fn(async () => {});
  const useChatApprovals = vi.fn(() => ({ requests: [] }));
  const useChatConversation = vi.fn(() => ({
    loading: false,
    sending: false,
    transcript: { working: false },
  }));
  const dependencies = {
    canMountTerminals: true,
    defaultSpec: { kind },
    terminalAgent,
    chatModeActive: true,
    tabState: { activeSessionId: "main", mainSessionId: "main" },
    sessionStatusById: new Map([["main", { lifecycle: "running" }]]),
    mainSessionReplacing: false,
    mainConversationGenerationRef: { current: 1 },
    mainConversationTransitionGateRef: { current: {} },
    screenThreadId: null,
    firstRunHealth: null,
    restoreDialog: null,
    voiceEntryDialog: null,
    reloadCurtainPhase: "hidden",
    claudeChatStore: {},
    readChatTranscript: vi.fn(),
    useChatApprovals,
    useChatConversation,
    useCallback: (callback: unknown) => callback,
    isConversationTransitionActive: () => false,
    getTerminalRuntime: () => ({ submitChatText: submit }),
    tabManager: { getState: () => ({ mainSessionId: "main" }) },
  };
  const gates = new Function(
    ...Object.keys(dependencies),
    `${gateJs}\nreturn { chatCanSend, chatStatus, submitChatText };`,
  )(...Object.values(dependencies)) as {
    chatCanSend: boolean;
    chatStatus: string;
    submitChatText: (text: string) => Promise<void>;
  };
  return { ...gates, submit, useChatApprovals, useChatConversation };
}

describe("App Chat availability after agent setup", () => {
  it.each([
    "codex",
    "claude",
  ] as const)("does not send Chat input to a setup-skip shell with saved provider %s", async (provider) => {
    const chat = setup("shell", provider);
    expect(chat.chatCanSend).toBe(false);
    expect(chat.chatStatus).toBe("unavailable");
    expect(chat.useChatApprovals).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
    expect(chat.useChatConversation).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    );
    await expect(chat.submitChatText("explain my project")).rejects.toThrow("not ready");
    expect(chat.submit).not.toHaveBeenCalled();
  });

  it.each([
    "codex",
    "claude",
  ] as const)("keeps the configured %s agent available for Chat", async (provider) => {
    const chat = setup("agent", provider);
    expect(chat.chatCanSend).toBe(true);
    expect(chat.chatStatus).toBe("ready");
    expect(chat.useChatApprovals).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
    expect(chat.useChatConversation).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true }),
    );
    await chat.submitChatText("explain my project");
    expect(chat.submit).toHaveBeenCalledExactlyOnceWith("explain my project");
  });
});
