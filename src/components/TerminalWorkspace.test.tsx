// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpawnSpec } from "../bindings/tauri-commands";
import type { Perception } from "../core/perception";
import TerminalWorkspace from "./TerminalWorkspace";

const { terminalProps } = vi.hoisted(() => ({
  terminalProps: [] as Array<{ cwd: string | null; spec: SpawnSpec }>,
}));

vi.mock("../terminal", () => ({
  default: (props: { cwd: string | null; spec: SpawnSpec }) => {
    terminalProps.push(props);
    return null;
  },
}));

describe("TerminalWorkspace", () => {
  afterEach(() => {
    cleanup();
    terminalProps.length = 0;
  });

  it("keeps terminal specs stable when only the fallback cwd changes", () => {
    const sessions = ["main"] as const;
    const spec = { kind: "agent", agent: "claude" } satisfies SpawnSpec;
    const getSpec = vi.fn(() => ({ ...spec }));
    const commonProps = {
      sessions,
      activeSessionId: "main",
      getSessionCwd: () => undefined,
      getSpec,
      getInterruptProtectionMode: () => "none" as const,
      perception: {} as Perception,
      shouldAttachExistingSession: () => false,
      onActivate: vi.fn(),
    };

    const { rerender } = render(<TerminalWorkspace {...commonProps} cwd="/old" />);
    const firstSpec = terminalProps[0]?.spec;

    rerender(<TerminalWorkspace {...commonProps} cwd="/new" />);

    expect(getSpec).toHaveBeenCalledTimes(1);
    expect(terminalProps).toHaveLength(2);
    expect(terminalProps[0]?.cwd).toBe("/old");
    expect(terminalProps[1]?.cwd).toBe("/new");
    expect(terminalProps[1]?.spec).toBe(firstSpec);
  });
});
