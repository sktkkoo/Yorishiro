// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { editAutonomyDraft } from "./client";
import { AutonomyDraftEditor, useAutonomyDraftEditor } from "./draft-editor";
import type { AutonomyDraft, AutonomyDraftSnapshot, DraftEditResult } from "./types";

vi.mock("./client", () => ({ editAutonomyDraft: vi.fn() }));

const draft: AutonomyDraft = {
  id: "first",
  goal: "整理する",
  root: "/notes",
  allowedOperations: ["write"],
  intervalMinutes: 30,
  maxRunsPerDay: 4,
  reviewMode: "daily",
  explanation: "会話からまとめた案",
};
const snapshot = (
  revision: number,
  changes: Partial<AutonomyDraft> = {},
): AutonomyDraftSnapshot => ({
  revision,
  draft: { ...draft, id: `draft-${revision}`, ...changes },
});
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("Deferred not initialized");
  };
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("shared autonomy draft editor", () => {
  it("preserves saved automatic action permission when editing another field", async () => {
    const submit = vi.fn().mockResolvedValue({
      snapshot: snapshot(1, { goal: "edited", automaticActionApproval: true }),
      conflict: false,
    });
    const editor = new AutonomyDraftEditor(submit);
    const previous = snapshot(1).draft;
    if (!previous) throw new Error("Fixture draft missing");
    editor.hydrate({
      ...previous,
      enabled: false,
      workMode: "documents",
      automaticActionApproval: true,
    });
    expect(editor.getSnapshot().values).toMatchObject({
      workMode: "documents",
      automaticActionApproval: true,
    });
    editor.edit("goal", "edited");
    await editor.submit();
    expect(submit).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ workMode: "documents", automaticActionApproval: true }),
    );
  });

  it("keeps an inactive draft's automatic action permission without changing the draft", () => {
    const submit = vi.fn();
    const editor = new AutonomyDraftEditor(submit);
    editor.receive(snapshot(1, { automaticActionApproval: true }));
    expect(editor.getSnapshot().values.automaticActionApproval).toBe(true);
    expect(editor.getSnapshot().synced).toBe(true);
    expect(submit).not.toHaveBeenCalled();
  });

  it("clears an obsolete publication grant without granting automatic action permission", async () => {
    const submit = vi.fn().mockResolvedValue({
      snapshot: snapshot(2, { publishPullRequest: false }),
      conflict: false,
    });
    const editor = new AutonomyDraftEditor(submit);
    editor.receive(snapshot(1, { publishPullRequest: true }));
    expect(editor.getSnapshot().values).toMatchObject({
      publishPullRequest: false,
      automaticActionApproval: false,
    });
    await editor.submit();
    expect(submit).toHaveBeenCalledExactlyOnceWith("draft-1", { publishPullRequest: false });
    expect(editor.getSnapshot().synced).toBe(true);
  });

  it("starts new drafts in automatic work selection without publication permission", () => {
    const editor = new AutonomyDraftEditor(vi.fn());
    expect(editor.getSnapshot().values).toMatchObject({
      workMode: "auto",
      publishPullRequest: false,
      automaticActionApproval: false,
    });
  });

  it("normalizes old snapshots to document-only scope without inferring development from the goal", () => {
    const editor = new AutonomyDraftEditor(vi.fn());
    editor.receive(snapshot(1, { goal: "Write code and create pull requests" }));
    expect(editor.getSnapshot().values).toMatchObject({
      workMode: "documents",
      publishPullRequest: false,
      automaticActionApproval: false,
    });
  });

  it.each([
    true,
    false,
  ])("preserves a manual automatic action permission setting of %s across unrelated AI updates", async (permission) => {
    const submit = vi.fn().mockResolvedValue({
      snapshot: snapshot(3, {
        workMode: "development",
        automaticActionApproval: permission,
        goal: "改善を実装する",
      }),
      conflict: false,
    });
    const editor = new AutonomyDraftEditor(submit);
    editor.receive(snapshot(1, { workMode: "development", automaticActionApproval: !permission }));
    editor.edit("automaticActionApproval", permission);
    editor.receive(
      snapshot(2, {
        workMode: "development",
        automaticActionApproval: !permission,
        goal: "改善を実装する",
      }),
    );
    expect(editor.getSnapshot().values.automaticActionApproval).toBe(permission);
    expect(editor.getSnapshot().values.goal).toBe("改善を実装する");
    await editor.flush();
    expect(submit).toHaveBeenCalledExactlyOnceWith("draft-2", {
      automaticActionApproval: permission,
    });
    expect(editor.getSnapshot().synced).toBe(true);
  });

  it("fills clean fields immediately and publishes human edits only as a draft patch", async () => {
    const submit = vi.fn().mockResolvedValue({
      snapshot: snapshot(2, { goal: "読みやすく整理する" }),
      conflict: false,
    });
    const editor = new AutonomyDraftEditor(submit);
    editor.receive(snapshot(1));
    expect(editor.getSnapshot().values.root).toBe("/notes");
    editor.edit("goal", "読みやすく整理する");
    expect(editor.getSnapshot().synced).toBe(false);
    await editor.submit();
    expect(submit).toHaveBeenCalledExactlyOnceWith("draft-1", { goal: "読みやすく整理する" });
    expect(editor.getSnapshot().synced).toBe(true);
  });

  it("merges a remote folder update while preserving a dirty local goal", async () => {
    const submit = vi.fn().mockResolvedValue({
      snapshot: snapshot(3, { root: "/new-notes", goal: "自分の目的" }),
      conflict: false,
    });
    const editor = new AutonomyDraftEditor(submit);
    editor.receive(snapshot(1));
    editor.edit("goal", "自分の目的");
    editor.receive(snapshot(2, { root: "/new-notes" }));
    expect(editor.getSnapshot().values).toMatchObject({ goal: "自分の目的", root: "/new-notes" });
    expect(editor.getSnapshot().conflicts).toEqual([]);
    await editor.submit();
    expect(submit).toHaveBeenCalledExactlyOnceWith("draft-2", { goal: "自分の目的" });
  });

  it.each([
    "remote",
    "local",
  ] as const)("requires an explicit %s choice when AI and user edit the same field", async (choice) => {
    const submit = vi
      .fn()
      .mockResolvedValue({ snapshot: snapshot(3, { goal: "自分の目的" }), conflict: false });
    const editor = new AutonomyDraftEditor(submit);
    editor.receive(snapshot(1));
    editor.edit("goal", "自分の目的");
    editor.receive(snapshot(2, { goal: "AIの新しい目的", root: "/new-notes" }));
    expect(editor.getSnapshot().values).toMatchObject({ goal: "自分の目的", root: "/new-notes" });
    expect(editor.getSnapshot().conflicts).toEqual(["goal"]);
    await editor.submit();
    expect(submit).not.toHaveBeenCalled();
    editor.resolve("goal", choice);
    if (choice === "remote") {
      expect(editor.getSnapshot().values.goal).toBe("AIの新しい目的");
      expect(editor.getSnapshot().synced).toBe(true);
    } else {
      await editor.submit();
      expect(submit).toHaveBeenCalledExactlyOnceWith("draft-2", { goal: "自分の目的" });
    }
  });

  it("does not clear newer typing when an older submitted edit is acknowledged", async () => {
    const pending = deferred<DraftEditResult>();
    const submit = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({
        snapshot: snapshot(3, { goal: "書き続けた内容" }),
        conflict: false,
      });
    const editor = new AutonomyDraftEditor(submit);
    editor.receive(snapshot(1));
    editor.edit("goal", "途中まで");
    const first = editor.submit();
    editor.edit("goal", "書き続けた内容");
    // Native event can precede the request response.
    editor.receive(snapshot(2, { goal: "途中まで" }));
    pending.resolve({ snapshot: snapshot(2, { goal: "途中まで" }), conflict: false });
    await first;
    expect(editor.getSnapshot().values.goal).toBe("書き続けた内容");
    expect(editor.getSnapshot().synced).toBe(false);
    expect(editor.getSnapshot().conflicts).toEqual([]);
    await editor.submit();
    expect(submit).toHaveBeenNthCalledWith(2, "draft-2", { goal: "書き続けた内容" });
    expect(editor.getSnapshot().synced).toBe(true);
  });

  it("ignores an old response after a newer remote update and retries disjoint CAS conflicts", async () => {
    const pending = deferred<DraftEditResult>();
    const submit = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({
        snapshot: snapshot(4, { goal: "人の変更", root: "/latest" }),
        conflict: false,
      });
    const editor = new AutonomyDraftEditor(submit);
    editor.receive(snapshot(1));
    editor.edit("goal", "人の変更");
    const first = editor.submit();
    editor.receive(snapshot(3, { root: "/latest" }));
    pending.resolve({ snapshot: snapshot(2, { root: "/older" }), conflict: true });
    await first;
    expect(editor.getSnapshot().values).toMatchObject({ root: "/latest", goal: "人の変更" });
    await editor.submit();
    expect(submit).toHaveBeenNthCalledWith(2, "draft-3", { goal: "人の変更" });
  });

  it("includes unchanged visible fields when creating a draft from a saved contract", async () => {
    const submit = vi.fn().mockResolvedValue({
      snapshot: snapshot(1, { goal: "更新した目的", reviewMode: "automatic" }),
      conflict: false,
    });
    const editor = new AutonomyDraftEditor(submit);
    editor.receive({ revision: 0, draft: null });
    editor.hydrate({ ...draft, enabled: false, reviewMode: undefined });
    editor.edit("goal", "更新した目的");
    await editor.submit();
    expect(submit).toHaveBeenCalledExactlyOnceWith(null, {
      goal: "更新した目的",
      root: "/notes",
      allowedOperations: ["write"],
      intervalMinutes: 30,
      maxRunsPerDay: 4,
      reviewMode: "automatic",
      workMode: "documents",
      publishPullRequest: false,
      automaticActionApproval: false,
    });
  });

  it("retains edits on a failed patch and retries only after retry or a new edit", async () => {
    const submit = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ snapshot: snapshot(2, { root: "/human" }), conflict: false });
    const editor = new AutonomyDraftEditor(submit);
    editor.receive(snapshot(1));
    editor.edit("root", "/human");
    await editor.submit();
    expect(editor.getSnapshot()).toMatchObject({
      error: "offline",
      synced: false,
      canSubmit: false,
    });
    expect(editor.getSnapshot().values.root).toBe("/human");
    await editor.submit();
    expect(submit).toHaveBeenCalledTimes(1);
    editor.retry();
    await editor.submit();
    expect(editor.getSnapshot().synced).toBe(true);
  });
  it("clears a conflict if the remote field returns to its original value", () => {
    const editor = new AutonomyDraftEditor(vi.fn());
    editor.receive(snapshot(1));
    editor.edit("goal", "人の目的");
    const editVersion = editor.getSnapshot().editVersion;
    editor.receive(snapshot(2, { goal: "AIの別案" }));
    expect(editor.getSnapshot().conflicts).toEqual(["goal"]);
    editor.receive(snapshot(3));
    expect(editor.getSnapshot().conflicts).toEqual([]);
    expect(editor.getSnapshot().values.goal).toBe("人の目的");
    expect(editor.getSnapshot().editVersion).toBe(editVersion);
  });

  it("flush waits for an in-flight submission then publishes newer typing before returning", async () => {
    const pending = deferred<DraftEditResult>();
    const submit = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({
        snapshot: snapshot(3, { goal: "最新の入力" }),
        conflict: false,
      });
    const editor = new AutonomyDraftEditor(submit);
    editor.receive(snapshot(1));
    editor.edit("goal", "途中の入力");
    const first = editor.submit();
    editor.edit("goal", "最新の入力");
    const flush = editor.flush();
    pending.resolve({ snapshot: snapshot(2, { goal: "途中の入力" }), conflict: false });
    await first;
    await flush;
    expect(submit).toHaveBeenNthCalledWith(2, "draft-2", { goal: "最新の入力" });
    expect(editor.getSnapshot().synced).toBe(true);
  });

  it("does not flush unresolved conflicts or invalid inputs into the next conversation", async () => {
    const submit = vi.fn();
    const editor = new AutonomyDraftEditor(submit);
    editor.receive(snapshot(1));
    editor.edit("goal", "人の目的");
    editor.receive(snapshot(2, { goal: "AIの目的" }));
    await expect(editor.flush()).rejects.toThrow("設定案の更新を確認");
    editor.resolve("goal", "remote");
    editor.edit("intervalMinutes", 0);
    await expect(editor.flush()).rejects.toThrow("設定案の更新を確認");
    expect(submit).not.toHaveBeenCalled();
  });
  it("does not postpone the typing debounce when unrelated AI fields arrive", async () => {
    vi.useFakeTimers();
    vi.mocked(editAutonomyDraft).mockResolvedValue({
      snapshot: snapshot(3, { root: "/new-folder", goal: "人の入力" }),
      conflict: false,
    });
    const hook = renderHook(({ remote }) => useAutonomyDraftEditor(remote, null), {
      initialProps: { remote: snapshot(1) },
    });
    try {
      act(() => hook.result.current.editor.edit("goal", "人の入力"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      hook.rerender({ remote: snapshot(2, { root: "/new-folder" }) });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(editAutonomyDraft).toHaveBeenCalledExactlyOnceWith("draft-2", { goal: "人の入力" });
      expect(hook.result.current.state.synced).toBe(true);
    } finally {
      hook.unmount();
      vi.useRealTimers();
      vi.mocked(editAutonomyDraft).mockReset();
    }
  });
});
