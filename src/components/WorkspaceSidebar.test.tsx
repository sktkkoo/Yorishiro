// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  COMMAND_RUN_ATTENTION_PRODUCER,
  createWorkspaceAttentionStore,
} from "../runtime/workspace-attention";
import WorkspaceSidebar from "./WorkspaceSidebar";

afterEach(() => {
  cleanup();
});

const LABELS = new Map([["session-1", "Claude"]]);

describe("WorkspaceSidebar", () => {
  it("active item が無いときは何も描画しない", () => {
    const store = createWorkspaceAttentionStore();
    const { container } = render(<WorkspaceSidebar store={store} labels={LABELS} />);
    expect(container.querySelector(".workspace-sidebar")).toBeNull();
  });

  it("active item を session ラベルつきで並べる", () => {
    const store = createWorkspaceAttentionStore();
    act(() => {
      store.upsert({
        sessionId: "session-1",
        locus: { kind: "session", sessionId: "session-1" },
        type: "run-failed",
        severity: "high",
        producer: COMMAND_RUN_ATTENTION_PRODUCER,
        producerKey: "command-block:session-1:1",
        detail: { command: "npm test", exitCode: 1 },
      });
    });
    render(<WorkspaceSidebar store={store} labels={LABELS} />);
    expect(screen.getByText("失敗")).toBeTruthy();
    expect(screen.getByText("Claude")).toBeTruthy();
    expect(screen.getByText("npm test")).toBeTruthy();
  });

  it("item が解決されたら描画を畳む", () => {
    const store = createWorkspaceAttentionStore();
    const item = store.upsert({
      sessionId: "session-1",
      locus: { kind: "session", sessionId: "session-1" },
      type: "run-failed",
      severity: "high",
      producer: COMMAND_RUN_ATTENTION_PRODUCER,
      producerKey: "command-block:session-1:1",
    });
    const { container } = render(<WorkspaceSidebar store={store} labels={LABELS} />);
    expect(container.querySelector(".workspace-sidebar")).not.toBeNull();
    act(() => {
      store.resolve(item.id);
    });
    expect(container.querySelector(".workspace-sidebar")).toBeNull();
  });
});
