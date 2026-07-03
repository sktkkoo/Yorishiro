import { describe, expect, it } from "vitest";
import { detectTerminalProblems } from "./terminal-problems";

describe("detectTerminalProblems", () => {
  it("file:line:col を file problem として検出する", () => {
    const problems = detectTerminalProblems("  at src/foo.ts:12:3 in stack");
    expect(problems).toContainEqual({ type: "file", value: "src/foo.ts:12:3" });
  });

  it("file:line（col 無し）も検出する", () => {
    const problems = detectTerminalProblems("ERROR foo/bar.rs:88");
    expect(problems).toContainEqual({ type: "file", value: "foo/bar.rs:88" });
  });

  it("http(s) URL は origin だけを検出する", () => {
    const problems = detectTerminalProblems("Local: http://localhost:5173/ ready");
    expect(problems.some((p) => p.type === "url" && p.value === "http://localhost:5173")).toBe(
      true,
    );
  });

  it("S3 signed URL は signature を捨てて origin だけを格納する", () => {
    const problems = detectTerminalProblems(
      "download https://bucket.s3.amazonaws.com/private.bin?X-Amz-Signature=secret-token",
    );

    expect(problems).toContainEqual({ type: "url", value: "https://bucket.s3.amazonaws.com" });
    expect(problems.some((p) => p.value.includes("X-Amz-Signature"))).toBe(false);
  });

  it("userinfo 付き URL は credentials を捨てて origin だけを格納する", () => {
    const problems = detectTerminalProblems("callback https://user:token@example.com/cb");

    expect(problems).toContainEqual({ type: "url", value: "https://example.com" });
    expect(problems.some((p) => p.value.includes("token"))).toBe(false);
  });

  it("path 内 token を含む URL は path ごと捨てて origin だけを格納する", () => {
    const problems = detectTerminalProblems("reset https://example.com/reset/abc123");

    expect(problems).toContainEqual({ type: "url", value: "https://example.com" });
    expect(problems.some((p) => p.value.includes("abc123"))).toBe(false);
  });

  it("同一 origin の複数 URL は redaction 後に 1 つへ畳む", () => {
    const problems = detectTerminalProblems(
      "a https://example.com/reset/abc123 b https://example.com/cb?token=secret",
    );

    expect(
      problems.filter((p) => p.type === "url" && p.value === "https://example.com"),
    ).toHaveLength(1);
  });

  it("localhost:port を port problem として検出する（拡張子なしなので file には拾わない）", () => {
    const problems = detectTerminalProblems("listening on localhost:3000");
    expect(problems).toContainEqual({ type: "port", value: "localhost:3000" });
    expect(problems.some((p) => p.type === "file")).toBe(false);
  });

  it("test failure 行を検出する", () => {
    const problems = detectTerminalProblems("FAIL src/foo.test.ts (2 failed)");
    expect(problems.some((p) => p.type === "test-fail")).toBe(true);
  });

  it("問題が無ければ空配列", () => {
    expect(detectTerminalProblems("hello world, all good")).toEqual([]);
  });

  it("同じ値の重複は 1 つに畳む", () => {
    const problems = detectTerminalProblems("a.ts:1 failed\nretry a.ts:1 failed");
    expect(problems.filter((p) => p.value === "a.ts:1")).toHaveLength(1);
  });

  it("検出数には上限がある（ログ洪水で膨らまない）", () => {
    const huge = Array.from({ length: 100 }, (_, i) => `f${i}.ts:${i}`).join("\n");
    const problems = detectTerminalProblems(huge);
    expect(problems.length).toBeLessThanOrEqual(20);
  });
});
