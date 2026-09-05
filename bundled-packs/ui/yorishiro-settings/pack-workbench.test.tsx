// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { UiContext } from "@yorishiro/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getStrings } from "../../../src/i18n/strings";
import { PackWorkbench } from "./ui";

afterEach(cleanup);

describe("Pack Workbench display names", () => {
  it("shows manifest names and sends stable IDs to diagnosis and pack actions", async () => {
    const diagnosePack = vi.fn().mockResolvedValue({
      ok: true,
      diagnoses: [],
      diagnostics: [],
      recommendations: [],
    });
    const disablePack = vi.fn().mockResolvedValue({ ok: true });
    const ctx = {
      app: {
        listPacks: vi.fn().mockResolvedValue({
          packs: [
            {
              id: "amber-window-room",
              name: "Twilight Café",
              kind: "scene",
              origin: "bundled",
              status: "loaded",
              isActive: true,
            },
            {
              id: "custom-room",
              name: "Local Café",
              kind: "scene",
              origin: "user",
              status: "loaded",
              isActive: false,
            },
            {
              id: "legacy-effect",
              kind: "effect",
              origin: "bundled",
              status: "loaded",
              isActive: false,
            },
          ],
        }),
        diagnosePack,
        disablePack,
      },
      emitEvent: vi.fn(),
    } as unknown as UiContext;

    render(<PackWorkbench ctx={ctx} strings={getStrings("en")} onClose={vi.fn()} />);
    const cafe = await screen.findByRole("button", { name: "Twilight Café" });
    expect(cafe.title).toBe("amber-window-room");
    expect(screen.queryByRole("button", { name: "amber-window-room" })).toBeNull();
    fireEvent.click(cafe);
    await waitFor(() =>
      expect(diagnosePack).toHaveBeenLastCalledWith("amber-window-room", "scene"),
    );
    expect(screen.getByText("amber-window-room")).toBeTruthy();
    expect(screen.getByText("bundled")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "legacy-effect" }));
    await waitFor(() => expect(diagnosePack).toHaveBeenLastCalledWith("legacy-effect", "effect"));

    fireEvent.click(screen.getByRole("switch", { name: "Disable pack Local Café" }));
    await waitFor(() => expect(disablePack).toHaveBeenCalledWith("custom-room"));
  });
});
