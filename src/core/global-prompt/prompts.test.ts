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

  it("grounds journal writing in events while preserving candid inner reflection", () => {
    const guide = getJournalGuide("ja");

    expect(guide).toContain("実際に認識した具体的な出来事、または読み返した過去の journal");
    expect(guide).toContain("発見や気づき、心を動かされたこと");
    expect(guide).toContain("考えが変わったり発展したりしたこと");
    expect(guide).toContain("嘘や演出を交えず正直に書く");
    expect(guide).toContain("創作したり誇張したりしない");
    expect(guide).toContain("欲望・不安・恐怖");
    expect(guide).toContain("自分に理解できないこと");
    expect(guide).not.toContain("その日の手触り");
    expect(guide).not.toContain("出来事の間にある「間」");
  });

  it("localizes memory headers without translating the tool name", () => {
    expect(getMemoriesHeader("en")).toContain("Memory fragments");
    expect(getMemoriesHeader("en")).toContain("journal_read");
    expect(getMemoriesHeader("ja")).toContain("記憶の断片");
    expect(getMemoriesHeader("ja")).toContain("journal_read");
  });
});
