// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Sidebar from "./sidebar";

afterEach(cleanup);

describe("Sidebar project selector spacing", () => {
  it("keeps normal spacing when the selector is visible", () => {
    const { container } = render(
      <Sidebar folderName="Project" onPickFolder={vi.fn()} showProjectSelector />,
    );
    expect(container.querySelector(".sidebar-project-selector-hidden")).toBeNull();
    expect(container.querySelector(".sidebar-top-row")).not.toBeNull();
  });

  it("collapses the empty top strip when compact-origin Settings hides the selector", () => {
    const { container } = render(
      <Sidebar folderName="Project" onPickFolder={vi.fn()} showProjectSelector={false} />,
    );
    expect(container.querySelector(".sidebar-project-selector-hidden")).not.toBeNull();
    expect(container.querySelector(".sidebar-top-row")).toBeNull();
  });
});
