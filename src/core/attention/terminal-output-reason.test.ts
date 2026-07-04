import { describe, expect, it } from "vitest";
import { classifyTerminalOutputAttentionReason } from "./terminal-output-reason";

describe("classifyTerminalOutputAttentionReason", () => {
  it("marks error-like output as diagnostic", () => {
    expect(classifyTerminalOutputAttentionReason("Error: build failed")).toBe("diagnostic");
    expect(classifyTerminalOutputAttentionReason("permission denied")).toBe("diagnostic");
    expect(classifyTerminalOutputAttentionReason("  diagnostic test")).toBe("diagnostic");
  });

  it("marks paths as file-link", () => {
    expect(classifyTerminalOutputAttentionReason("src/App.tsx:1157")).toBe("file-link");
    expect(
      classifyTerminalOutputAttentionReason("./docs/decisions/attention-aura-targets.md"),
    ).toBe("file-link");
  });

  it("uses recent-output as fallback", () => {
    expect(classifyTerminalOutputAttentionReason("Listening on port 1430")).toBe("recent-output");
  });

  it("shell の代表的なエラー行を diagnostic として拾う", () => {
    expect(classifyTerminalOutputAttentionReason("cat: memo.txt: No such file or directory")).toBe(
      "diagnostic",
    );
    expect(
      classifyTerminalOutputAttentionReason(
        "fatal: not a git repository (or any of the parent directories)",
      ),
    ).toBe("diagnostic");
    expect(classifyTerminalOutputAttentionReason("rm: config: Operation not permitted")).toBe(
      "diagnostic",
    );
    expect(
      classifyTerminalOutputAttentionReason("curl: (7) Failed to connect: Connection refused"),
    ).toBe("diagnostic");
    expect(classifyTerminalOutputAttentionReason("zsh: segmentation fault  ./a.out")).toBe(
      "diagnostic",
    );
  });

  it("ゼロ件サマリ（0 failed / 0 errors）は diagnostic にしない", () => {
    expect(classifyTerminalOutputAttentionReason("Tests: 120 passed, 0 failed")).toBe(
      "recent-output",
    );
    expect(classifyTerminalOutputAttentionReason("compiled with 0 errors and 0 warnings")).toBe(
      "recent-output",
    );
    // ゼロ件と実エラー語彙が同居する行は diagnostic のまま
    expect(classifyTerminalOutputAttentionReason("0 failed, but fatal: index corrupt")).toBe(
      "diagnostic",
    );
  });

  it("エラー語彙を含むだけのファイル名は diagnostic にしない", () => {
    expect(classifyTerminalOutputAttentionReason("error.log  notes.md  src")).toBe("file-link");
    // ファイル名 + 実エラー語彙の行は diagnostic のまま
    expect(classifyTerminalOutputAttentionReason("cat: error.log: No such file or directory")).toBe(
      "diagnostic",
    );
  });
});
