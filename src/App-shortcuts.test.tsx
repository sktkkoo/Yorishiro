// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import appSource from "./App.tsx?raw";
import { QuickChatInput } from "./components/QuickChatInput";

// Execute App's actual capture effect without booting its native/3D runtime.
// Component-only tests cannot catch a window listener consuming the event first.
const app = ts.createSourceFile(
  "App.tsx",
  appSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
let captureEffect: ts.ArrowFunction | undefined;
function findCaptureEffect(node: ts.Node): void {
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(app) === "useEffect" &&
    node.arguments[0] &&
    ts.isArrowFunction(node.arguments[0]) &&
    node.arguments[0].getText(app).includes('event.code === "Escape" && quickChatOpen')
  ) {
    captureEffect = node.arguments[0];
  }
  ts.forEachChild(node, findCaptureEffect);
}
findCaptureEffect(app);
if (!captureEffect) throw new Error("App's quick-chat capture effect was not found");
const captureEffectJs = ts.transpileModule(`(${captureEffect.getText(app)})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2020 },
}).outputText;

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanups.splice(0)) dispose();
  cleanup();
});

function installCapture(overrides: Record<string, unknown> = {}) {
  const dependencies = {
    window,
    quickChatOpen: true,
    setQuickChatOpen: vi.fn(),
    quickVoiceStatus: null,
    conversationPaletteMode: true,
    stopCodexRealtime: vi.fn(),
    handleOpenSettings: vi.fn(),
    setLevaHidden: vi.fn(),
    viewModeShortcuts: [],
    matchesViewModeShortcut: vi.fn(() => false),
    isMac: true,
    viewModeOwnsChrome: true,
    handleSelectViewMode: vi.fn(),
    ...overrides,
  };
  const effect = new Function(...Object.keys(dependencies), `return ${captureEffectJs}`)(
    ...Object.values(dependencies),
  ) as () => () => void;
  cleanups.push(effect());
  return dependencies;
}

function renderQuickChat() {
  const onClose = vi.fn();
  render(
    <QuickChatInput
      value="変換中"
      strings={{ placeholder: "Message", inputLabel: "Quick chat", send: "Send", close: "Close" }}
      onChange={vi.fn()}
      onSubmit={vi.fn()}
      onClose={onClose}
    />,
  );
  return { input: screen.getByRole("textbox"), onClose };
}

describe("App quick-chat capture shortcuts", () => {
  it.each([
    { isComposing: true },
    { isComposing: false, keyCode: 229 },
  ])("leaves IME Escape to the focused input: %j", (composition) => {
    const actions = installCapture();
    const { input, onClose } = renderQuickChat();

    expect(fireEvent.keyDown(input, { key: "Escape", code: "Escape", ...composition })).toBe(true);
    expect(actions.setQuickChatOpen).not.toHaveBeenCalled();
    expect(actions.handleSelectViewMode).not.toHaveBeenCalled();
    expect(actions.stopCodexRealtime).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);

    // A subsequent ordinary Escape is still handled once, by the capture listener.
    expect(fireEvent.keyDown(input, { key: "Escape", code: "Escape" })).toBe(false);
    expect(actions.setQuickChatOpen).toHaveBeenCalledExactlyOnceWith(false);
    expect(actions.handleSelectViewMode).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("preserves settings and debug shortcuts while quick chat is open", () => {
    const actions = installCapture();
    const { input } = renderQuickChat();
    fireEvent.keyDown(input, { key: ",", code: "Comma", metaKey: true });
    fireEvent.keyDown(input, { key: "F2", code: "F2" });
    expect(actions.handleOpenSettings).toHaveBeenCalledOnce();
    expect(actions.setLevaHidden).toHaveBeenCalledOnce();
    expect(actions.setQuickChatOpen).not.toHaveBeenCalled();
  });

  it("preserves voice Escape when quick chat is closed", () => {
    const actions = installCapture({ quickChatOpen: false, quickVoiceStatus: "active" });
    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });
    expect(actions.stopCodexRealtime).toHaveBeenCalledOnce();
    expect(actions.handleSelectViewMode).not.toHaveBeenCalled();
    expect(actions.setQuickChatOpen).not.toHaveBeenCalled();
  });

  it("preserves View Mode Escape when the conversation palettes are closed", () => {
    const actions = installCapture({ quickChatOpen: false });
    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });
    expect(actions.handleSelectViewMode).toHaveBeenCalledExactlyOnceWith(null);
    expect(actions.setQuickChatOpen).not.toHaveBeenCalled();
  });
});
