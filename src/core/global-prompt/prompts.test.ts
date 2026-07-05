import { describe, expect, it } from "vitest";
import { getEnvironmentGuide, getJournalGuide, getMemoriesHeader } from "./prompts";

describe("global prompt localization", () => {
  it("returns English environment guidance", () => {
    const guide = getEnvironmentGuide("en");
    expect(guide).toContain("Yorishiro Environment");
    expect(guide).toContain("~/.yorishiro/config.json");
  });

  it("returns Japanese environment guidance", () => {
    const guide = getEnvironmentGuide("ja");
    expect(guide).toContain("Yorishiro 環境");
    expect(guide).toContain("~/.yorishiro/config.json");
  });

  it("keeps MCP tool identifiers stable in both journal guides", () => {
    expect(getJournalGuide("en")).toContain("journal_write");
    expect(getJournalGuide("en")).toContain("journal_read");
    expect(getJournalGuide("ja")).toContain("journal_write");
    expect(getJournalGuide("ja")).toContain("journal_read");
  });

  it("localizes memory headers without translating the tool name", () => {
    expect(getMemoriesHeader("en")).toContain("Memory fragments");
    expect(getMemoriesHeader("en")).toContain("journal_read");
    expect(getMemoriesHeader("ja")).toContain("記憶の断片");
    expect(getMemoriesHeader("ja")).toContain("journal_read");
  });
});
