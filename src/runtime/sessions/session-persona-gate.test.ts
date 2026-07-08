import { describe, expect, it } from "vitest";
import {
  normalizePersonaForGate,
  parseSessionPersonaRecords,
  serializeSessionPersonaRecords,
  shouldAllowPersonaResume,
  withSessionPersonaRecord,
} from "./session-persona-gate";

const AT = "2026-07-08T12:00:00.000Z";

describe("normalizePersonaForGate", () => {
  it("treats bundled CLAI as one language-neutral persona", () => {
    // 生の resolved id（clai-en / clai-ja）で比較すると UI 言語切替が
    // persona 切替に誤爆する。
    expect(normalizePersonaForGate(null)).toBe("clai");
    expect(normalizePersonaForGate("clai-en")).toBe("clai");
    expect(normalizePersonaForGate("clai-ja")).toBe("clai");
  });

  it("keeps user persona ids as-is", () => {
    expect(normalizePersonaForGate("my-persona")).toBe("my-persona");
  });
});

describe("parseSessionPersonaRecords", () => {
  it("returns empty records for missing or broken files", () => {
    expect(parseSessionPersonaRecords("")).toEqual({});
    expect(parseSessionPersonaRecords("not json {")).toEqual({});
    expect(parseSessionPersonaRecords("42")).toEqual({});
    expect(parseSessionPersonaRecords('{"records": 3}')).toEqual({});
  });

  it("drops malformed entries but keeps valid ones", () => {
    const text = JSON.stringify({
      version: 1,
      records: {
        claude: {
          "/proj/a": { persona: "clai", resumeAllowed: true, at: AT },
          "/proj/bad": { persona: 5 },
        },
        codex: "broken",
      },
    });
    expect(parseSessionPersonaRecords(text)).toEqual({
      claude: { "/proj/a": { persona: "clai", resumeAllowed: true, at: AT } },
    });
  });

  it("round-trips through serialize", () => {
    const records = withSessionPersonaRecord(
      {},
      {
        agent: "claude",
        place: "/proj/a",
        persona: "my-persona",
        resumeAllowed: false,
        at: AT,
      },
    );
    expect(parseSessionPersonaRecords(serializeSessionPersonaRecords(records))).toEqual(records);
  });
});

describe("shouldAllowPersonaResume", () => {
  const records = withSessionPersonaRecord(
    {},
    {
      agent: "claude",
      place: "/proj/a",
      persona: "clai",
      resumeAllowed: true,
      at: AT,
    },
  );

  it("allows resume when no record exists (fail-open for first run / upgrades)", () => {
    expect(
      shouldAllowPersonaResume({}, { agent: "claude", place: "/proj/a", persona: "clai" }),
    ).toBe(true);
    expect(
      shouldAllowPersonaResume(records, { agent: "codex", place: "/proj/a", persona: "clai" }),
    ).toBe(true);
    expect(
      shouldAllowPersonaResume(records, { agent: "claude", place: "/proj/b", persona: "clai" }),
    ).toBe(true);
  });

  it("allows resume when the recorded persona matches", () => {
    expect(
      shouldAllowPersonaResume(records, { agent: "claude", place: "/proj/a", persona: "clai" }),
    ).toBe(true);
  });

  it("blocks resume when the persona changed since the last spawn", () => {
    expect(
      shouldAllowPersonaResume(records, {
        agent: "claude",
        place: "/proj/a",
        persona: "my-persona",
      }),
    ).toBe(false);
  });
});

describe("withSessionPersonaRecord", () => {
  it("overwrites the target record and keeps other agents and places", () => {
    let records = withSessionPersonaRecord(
      {},
      {
        agent: "claude",
        place: "/proj/a",
        persona: "clai",
        resumeAllowed: true,
        at: AT,
      },
    );
    records = withSessionPersonaRecord(records, {
      agent: "codex",
      place: "/proj/a",
      persona: "clai",
      resumeAllowed: true,
      at: AT,
    });
    records = withSessionPersonaRecord(records, {
      agent: "claude",
      place: "/proj/a",
      persona: "my-persona",
      resumeAllowed: false,
      at: AT,
    });
    expect(records.claude?.["/proj/a"]?.persona).toBe("my-persona");
    expect(records.claude?.["/proj/a"]?.resumeAllowed).toBe(false);
    expect(records.codex?.["/proj/a"]?.persona).toBe("clai");
  });
});

describe("persona switch scenario across agents (the leak this gate closes)", () => {
  it("blocks the other agent's stale thread after a persona switch, then heals", () => {
    // セッション A（claude, persona X）と過去の codex セッション C（persona X）。
    let records = withSessionPersonaRecord(
      {},
      {
        agent: "claude",
        place: "/proj",
        persona: "persona-x",
        resumeAllowed: true,
        at: AT,
      },
    );
    records = withSessionPersonaRecord(records, {
      agent: "codex",
      place: "/proj",
      persona: "persona-x",
      resumeAllowed: true,
      at: AT,
    });

    // persona X → Y に切替（fresh respawn の boot で claude の記録が Y に更新される）。
    expect(
      shouldAllowPersonaResume(records, { agent: "claude", place: "/proj", persona: "persona-y" }),
    ).toBe(false);
    records = withSessionPersonaRecord(records, {
      agent: "claude",
      place: "/proj",
      persona: "persona-y",
      resumeAllowed: false,
      at: AT,
    });

    // claude → codex に切替：codex の記録は persona X のまま → 旧スレッド resume を阻止。
    expect(
      shouldAllowPersonaResume(records, { agent: "codex", place: "/proj", persona: "persona-y" }),
    ).toBe(false);
    records = withSessionPersonaRecord(records, {
      agent: "codex",
      place: "/proj",
      persona: "persona-y",
      resumeAllowed: false,
      at: AT,
    });

    // codex → claude に戻す：claude の記録は persona Y に更新済み → 続きから再開できる。
    expect(
      shouldAllowPersonaResume(records, { agent: "claude", place: "/proj", persona: "persona-y" }),
    ).toBe(true);
  });
});
