import { describe, expect, it } from "vitest";
import { applyLayout, type LayoutTargets, resetLayout } from "./ui-layout-engine";

/** DOM-less test stub。style は index signature を持つ dummy、HTMLElement として扱う */
interface StubStyle {
  [key: string]: string;
  width: string;
  minWidth: string;
  display: string;
  position: string;
  zIndex: string;
  background: string;
  borderRight: string;
  top: string;
  left: string;
  height: string;
}

const makeStubStyle = (): StubStyle =>
  ({
    width: "",
    minWidth: "",
    display: "",
    position: "",
    zIndex: "",
    background: "",
    borderRight: "",
    top: "",
    left: "",
    height: "",
  }) as StubStyle;

const makeStubElement = () => ({ style: makeStubStyle() }) as unknown as HTMLElement;

const makeTargets = (): LayoutTargets => ({
  root: makeStubElement(),
  terminal: makeStubElement(),
  sidebar: makeStubElement(),
  character: makeStubElement(),
  chrome: makeStubElement(),
});

describe("applyLayout", () => {
  it("空の layout spec は何も変更しない", () => {
    const targets = makeTargets();
    applyLayout({}, targets);
    expect(targets.terminal.style.display).toBe("");
    expect(targets.sidebar.style.width).toBe("");
  });

  it("terminal の絶対配置を適用する", () => {
    const targets = makeTargets();
    applyLayout(
      {
        terminal: {
          position: {
            top: "20%",
            left: "280px",
            width: "calc(100% - 280px)",
            height: "80%",
          },
        },
      },
      targets,
    );
    expect(targets.terminal.style.position).toBe("fixed");
    expect(targets.terminal.style.top).toBe("20%");
    expect(targets.terminal.style.height).toBe("80%");
  });

  it("terminal position=hidden で display:none", () => {
    const targets = makeTargets();
    applyLayout({ terminal: { position: "hidden" } }, targets);
    expect(targets.terminal.style.display).toBe("none");
  });

  it("terminal position=bottom で下 40% 配置 shortcut", () => {
    const targets = makeTargets();
    applyLayout({ terminal: { position: "bottom" } }, targets);
    expect(targets.terminal.style.position).toBe("fixed");
    expect(targets.terminal.style.top).toBe("60%");
    expect(targets.terminal.style.left).toBe("var(--sidebar-width)");
    expect(targets.terminal.style.width).toBe("calc(100% - var(--sidebar-width))");
    expect(targets.terminal.style.height).toBe("40%");
  });

  it("sidebar fullscreen で width:100vw", () => {
    const targets = makeTargets();
    applyLayout({ sidebar: { width: "fullscreen" } }, targets);
    expect(targets.sidebar.style.width).toBe("100vw");
    expect(targets.sidebar.style.minWidth).toBe("100vw");
  });

  it("sidebar position=overlay は fixed で viewport 全体を占有する", () => {
    const targets = makeTargets();
    applyLayout({ sidebar: { width: "fullscreen", position: "overlay" } }, targets);
    expect(targets.sidebar.style.position).toBe("fixed");
    expect(targets.sidebar.style.zIndex).toBe("100");
    // fixed 要素は top/left/height が無いと縦に潰れる（子の character viewport が 0 高さ）。
    expect(targets.sidebar.style.top).toBe("0");
    expect(targets.sidebar.style.left).toBe("0");
    expect(targets.sidebar.style.height).toBe("100vh");
    expect(targets.sidebar.style.width).toBe("100vw");
  });

  it("resetLayout は overlay の top/left/height も空に戻す", () => {
    const targets = makeTargets();
    applyLayout({ sidebar: { width: "fullscreen", position: "overlay" } }, targets);
    resetLayout(targets);
    expect(targets.sidebar.style.position).toBe("");
    expect(targets.sidebar.style.top).toBe("");
    expect(targets.sidebar.style.left).toBe("");
    expect(targets.sidebar.style.height).toBe("");
  });

  it("sidebar 数値指定で px", () => {
    const targets = makeTargets();
    applyLayout({ sidebar: { width: 400 } }, targets);
    expect(targets.sidebar.style.width).toBe("400px");
    expect(targets.sidebar.style.minWidth).toBe("400px");
  });

  it("character visible:false で display:none", () => {
    const targets = makeTargets();
    applyLayout({ character: { visible: false } }, targets);
    expect(targets.character.style.display).toBe("none");
  });
});

describe("resetLayout", () => {
  it("適用した style を空文字に戻す（terminal）", () => {
    const targets = makeTargets();
    applyLayout({ terminal: { position: "hidden" } }, targets);
    resetLayout(targets);
    expect(targets.terminal.style.display).toBe("");
  });

  it("適用した style を空文字に戻す（sidebar）", () => {
    const targets = makeTargets();
    applyLayout({ sidebar: { width: 400 } }, targets);
    resetLayout(targets);
    expect(targets.sidebar.style.width).toBe("");
    expect(targets.sidebar.style.minWidth).toBe("");
  });

  it("root も reset loop に含まれる（Plan 2 以降の拡張性）", () => {
    const targets = makeTargets();
    // Plan 1 では root を touch しないが、reset loop に含めて将来の拡張に備える
    targets.root.style.width = "should-be-cleared";
    resetLayout(targets);
    expect(targets.root.style.width).toBe("");
  });
});

describe("full-replace semantics（update で前の値が残らない）", () => {
  it("applyLayout はオプショナルに reset を伴う形で使う（A → reset → B で A の値が残らない）", () => {
    const targets = makeTargets();
    applyLayout({ terminal: { position: "hidden" } }, targets);
    resetLayout(targets);
    applyLayout({ sidebar: { width: "fullscreen" } }, targets);
    expect(targets.terminal.style.display).toBe("");
    expect(targets.sidebar.style.width).toBe("100vw");
  });
});

describe("applyLayout chrome", () => {
  it("chrome.visible:false で chrome を display:none", () => {
    const t = makeTargets();
    applyLayout({ chrome: { visible: false } }, t);
    expect(t.chrome.style.display).toBe("none");
  });

  it("chrome 未指定では chrome を触らない", () => {
    const t = makeTargets();
    applyLayout({ sidebar: { width: "fullscreen" } }, t);
    expect(t.chrome.style.display).toBe("");
  });

  it("resetLayout は chrome の display を空に戻す", () => {
    const t = makeTargets();
    applyLayout({ chrome: { visible: false } }, t);
    resetLayout(t);
    expect(t.chrome.style.display).toBe("");
  });
});
