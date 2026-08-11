import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const pomodoroUiPath = join(
  import.meta.dirname,
  "../../bundled-packs/ambient-ui/pomodoro-ui/ui.tsx",
);

describe("bundled ambient UI amenity service contract", () => {
  it("pomodoro-ui consumes the public mount context without an internal registry import", async () => {
    const source = await readFile(pomodoroUiPath, "utf8");

    expect(source).toContain('from "@yorishiro/sdk"');
    expect(source).toContain('amenities.get("pomodoro")');
    expect(source).not.toContain("getAmenityPackRegistry");
    expect(source).not.toContain("src/runtime/");
  });
});
