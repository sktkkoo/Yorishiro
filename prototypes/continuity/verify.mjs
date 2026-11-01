import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

const html = fs.readFileSync(new URL("index.html", import.meta.url), "utf8");
const script = fs.readFileSync(new URL("app.js", import.meta.url), "utf8");
const storageKey = "yorishiro-continuity-prototype-v1";

function setup(saved) {
  const dom = new JSDOM(html, {
    url: "https://prototype.example/continuity/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  let clock = 0;
  let nextId = 0;
  const scheduled = new Map();
  window.Date.now = () => clock;
  window.setTimeout = (callback, delay = 0) => {
    const id = ++nextId;
    scheduled.set(id, { callback, at: clock + delay });
    return id;
  };
  window.clearTimeout = (id) => scheduled.delete(id);
  window.HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true;
  };
  window.HTMLDialogElement.prototype.close = function close() {
    this.open = false;
    this.dispatchEvent(new window.Event("close"));
  };
  if (saved !== undefined) window.localStorage.setItem(storageKey, saved);
  window.eval(script);
  const query = (selector) => window.document.querySelector(selector);
  const click = (selector) => {
    const target = query(selector);
    assert.ok(target, `Missing control ${selector}`);
    target.click();
  };
  function send(text) {
    query("#message-input").value = text;
    query("#conversation-form").dispatchEvent(
      new window.Event("submit", { bubbles: true, cancelable: true }),
    );
  }
  function advance(ms) {
    const target = clock + ms;
    for (let count = 0; count < 1000; count++) {
      const next = [...scheduled]
        .filter(([, item]) => item.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, item] = next;
      scheduled.delete(id);
      clock = item.at;
      item.callback();
    }
    clock = target;
  }
  return {
    dom,
    window,
    query,
    click,
    send,
    advance,
    saved: () => window.localStorage.getItem(storageKey),
    state: () => JSON.parse(window.localStorage.getItem(storageKey)),
    text: () => query("#conversation-log").textContent,
  };
}

test("Yori initiates; correction changes memory, draft, and next day's initiative", () => {
  const app = setup();
  assert.match(app.text(), /昨日の「細かなPR/);
  assert.equal(app.query('[data-role="user"]'), null);
  app.send("PRをまとめるより、体験から考えてほしい");
  assert.equal(app.state().draft, "working");
  assert.match(app.state().memories.find((item) => item.id === "preference").value, /使う人の体験/);
  assert.equal(app.state().memories.find((item) => item.id === "preference").revisions.length, 1);
  app.send("理由も覚えておいて");
  app.advance(7000);
  assert.equal(app.state().draft, "ready");
  assert.equal(app.state().feedback, false, "Successful output is not user approval");
  app.send("こういう方向がいい");
  assert.equal(app.state().feedback, true);
  app.click('[data-action="next-day"]');
  assert.match(app.text(), /前に話した「体験から考えてほしい」/);
  assert.match(app.text(), /実際に触れる形/);
  assert.equal(app.state().day, 2);
  assert.ok(app.state().journal.some((entry) => entry.title === "前の訂正が、今日の着眼点になる"));
  app.dom.window.close();
});

test("withdrawing a proposal cancels pending results and is remembered next day", () => {
  const app = setup();
  app.send("体験から考えてほしい");
  app.advance(1000);
  app.send("今は話すだけにしたい");
  app.advance(10000);
  assert.notEqual(app.state().draft, "ready");
  assert.equal(app.query('[aria-label="体験の草案"]'), null);
  app.click('[data-action="next-day"]');
  assert.match(app.state().messages.at(-1).text, /前の案はいったん置いて/);
  assert.equal(app.state().messages.at(-1).artifact, null);
  app.dom.window.close();
});

test("quiet feedback reduces initiative, instead of creating another unsolicited task", () => {
  const app = setup();
  app.send("体験から考えてほしい");
  app.send("提案は少なめがいい");
  const messageCount = app.state().messages.length;
  app.advance(10000);
  assert.equal(app.state().draft, "ready", "Quiet changes notifications, not work");
  assert.equal(app.state().messages.length, messageCount, "Completion must not interrupt the chat");
  assert.match(app.query("#presence-footnote").textContent, /草案があります/);
  app.click('[data-action="next-day"]');
  assert.equal(app.state().initiative, "quiet");
  assert.equal(app.state().messages.at(-1).artifact, "quiet-note");
  assert.equal(app.query('[aria-label="体験の草案"]'), null);
  app.dom.window.close();
});

test("reset to first meeting clears history and cancels old asynchronous output", () => {
  const app = setup();
  app.send("体験から考えてほしい");
  app.click('[data-action="scenes"]');
  app.click('[data-scene="first"]');
  app.advance(10000);
  assert.equal(app.state().messages.length, 1);
  assert.equal(app.state().memories.length, 0);
  assert.equal(app.state().draft, "none");
  assert.match(app.text(), /はじめまして/);
  assert.doesNotMatch(app.text(), /昨日|草案/);
  app.dom.window.close();
});

test("free text is escaped, recorded, and does not pretend to execute work", () => {
  const app = setup();
  const input = '<img src=x onerror="alert(1)">';
  app.send(input);
  assert.equal(app.query('#conversation-log img[src="x"]'), null);
  assert.match(app.text(), /<img src=x/);
  assert.match(app.state().messages.at(-1).note, /用意したシナリオ/);
  assert.equal(app.state().draft, "none");
  app.dom.window.close();
});

test("reload retains corrected understanding and draft input; corrupt storage recovers", () => {
  const first = setup();
  first.send("体験から考えてほしい");
  first.query("#message-input").value = "まだ考えている途中";
  first.query("#message-input").dispatchEvent(new first.window.Event("input"));
  const second = setup(first.saved());
  assert.equal(second.state().direction, "experience");
  assert.equal(second.state().draft, "interrupted");
  assert.equal(second.query("#message-input").value, "まだ考えている途中");
  second.advance(10000);
  assert.equal(second.query('[aria-label="体験の草案"]'), null);
  second.click('[data-action="next-day"]');
  assert.match(second.state().messages.at(-1).text, /草案はまだ途中/);
  assert.equal(second.state().messages.at(-1).artifact, null);
  const third = setup('{"version":1,"messages":[null]}');
  assert.equal(third.state().scene, "return");
  assert.match(third.text(), /おかえり/);
  for (const app of [first, second, third]) app.dom.window.close();
});

test("memory correction is editable through conversation and survives into next day", () => {
  const app = setup();
  app.click('[data-action="notebook"]');
  app.click('[data-action="correct-memory"][data-memory="preference"]');
  assert.equal(app.query("#notebook").hidden, true);
  assert.equal(app.query("#message-input"), app.window.document.activeElement);
  app.send("大切にしていることについて：いまは調査を深める時間を優先したい");
  assert.match(app.state().memories.find((item) => item.id === "preference").value, /調査を深める/);
  app.click('[data-action="next-day"]');
  assert.match(app.state().messages.at(-1).text, /調査を深める/);
  app.dom.window.close();
});

test("IME Enter does not send before composition ends", () => {
  const app = setup();
  app.query("#message-input").value = "編集中";
  app.query("#message-input").dispatchEvent(new app.window.CompositionEvent("compositionstart"));
  app
    .query("#message-input")
    .dispatchEvent(new app.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.equal(app.state().messages.length, 1);
  app.query("#message-input").dispatchEvent(new app.window.CompositionEvent("compositionend"));
  app
    .query("#message-input")
    .dispatchEvent(new app.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.equal(app.state().messages.length, 3);
  app.dom.window.close();
});

test("sending follows the new answer; background completion preserves reading and offers a new-reply control", () => {
  const app = setup();
  const flow = app.query(".conversation-flow");
  Object.defineProperties(flow, {
    scrollHeight: {
      configurable: true,
      get: () => app.window.document.querySelectorAll(".message").length * 200,
    },
    clientHeight: { configurable: true, value: 100 },
  });
  flow.scrollTop = 0;
  app.send("体験から考えてほしい");
  assert.equal(flow.scrollTop, flow.scrollHeight, "Explicit send must show its answer");
  const originalButton = app.query('[data-action="view-artifact"][data-kind="grouping"]');
  originalButton.focus();
  flow.scrollTop = 0;
  app.advance(7000);
  assert.equal(flow.scrollTop, 0, "Background completion must not move a reader");
  assert.equal(app.query('[data-action="view-artifact"][data-kind="grouping"]'), originalButton);
  assert.equal(
    app.window.document.activeElement,
    originalButton,
    "Old message controls keep focus",
  );
  assert.equal(app.query("#new-reply").hidden, false);
  app.click('[data-action="latest"]');
  assert.equal(flow.scrollTop, flow.scrollHeight);
  assert.equal(app.query("#new-reply").hidden, true);
  app.dom.window.close();
});

test("scope and background corrections update their own fields without replacing the topic", () => {
  const app = setup();
  app.send("体験から考えてほしい");
  const concern = app.state().concern;
  app.click('[data-action="notebook"]');
  app.click('[data-action="correct-memory"][data-memory="scope"]');
  app.send("任されている範囲について：公開前は必ず一緒に見たい");
  assert.equal(app.state().direction, "experience");
  assert.equal(app.state().concern, concern);
  assert.equal(app.state().draft, "working");
  app.click('[data-action="notebook"]');
  app.click('[data-action="correct-memory"][data-memory="background"]');
  app.send("その背景について：取り込むときの判断が重くなっている");
  assert.equal(app.state().direction, "experience");
  assert.equal(app.state().concern, concern);
  assert.equal(app.state().draft, "working");
  app.advance(7000);
  assert.equal(app.state().draft, "ready");
  app.dom.window.close();
});

test("notification preference can be corrected and restored without reviving a withdrawn proposal", () => {
  const app = setup();
  app.send("提案は少なめがいい");
  app.send("体験から考えてほしい");
  assert.equal(app.state().draft, "working", "Quiet does not block a discussed draft");
  app.click('[data-action="notebook"]');
  app.click('[data-action="correct-memory"][data-memory="initiative"]');
  app.send("声をかけるタイミングについて：また提案していいよ");
  assert.equal(app.state().initiative, "normal");
  assert.equal(app.state().direction, "experience");
  app.send("今は話すだけにしたい");
  app.send("提案は少なめがいい");
  app.send("また提案していいよ");
  assert.equal(app.state().initiative, "normal");
  assert.equal(app.state().withdrawn, true);
  app.advance(10000);
  assert.equal(app.state().draft, "interrupted");
  assert.equal(app.state().messages.at(-1).artifact, null);
  app.dom.window.close();
});

test("partial and complete quiet notes reflect their original state; day labels remain relative", () => {
  const app = setup();
  app.send("体験から考えてほしい");
  app.send("提案は少なめがいい");
  app.click('[data-action="next-day"]');
  const partialNote = app.state().messages.at(-1);
  assert.equal(partialNote.artifactState, "interrupted");
  const partialNode = app.query(`#${partialNote.id}`);
  assert.match(partialNode.textContent, /考えかけのメモ/);
  assert.doesNotMatch(partialNode.textContent, /体験の草案/);
  app.send("草案の続きを見せて");
  app.advance(7000);
  assert.equal(app.state().draft, "ready");
  assert.equal(app.query(`#${partialNote.id}`), partialNode);
  assert.match(partialNode.textContent, /考えかけのメモ/, "Historical cards are snapshots");
  app.click('[data-action="next-day"]');
  assert.equal(app.state().messages.at(-1).artifactState, "ready");
  const labels = [...app.window.document.querySelectorAll(".day-divider")].map(
    (node) => node.textContent,
  );
  assert.deepEqual(labels, ["2日前", "昨日", "今日"]);
  app.send("また提案して");
  app.click('[data-action="next-day"]');
  assert.match(app.state().messages.at(-1).text, /前に話した/);
  assert.doesNotMatch(app.state().messages.at(-1).text, /昨日/);
  app.dom.window.close();
});

test("notebook disclosures and focus survive background result updates", () => {
  const app = setup();
  app.send("体験から考えてほしい");
  app.click('[data-action="notebook"]');
  const disclosure = app.query('[data-memory-revision="preference"]');
  disclosure.open = true;
  disclosure.querySelector("summary").focus();
  app.advance(7000);
  const updated = app.query('[data-memory-revision="preference"]');
  assert.equal(updated.open, true);
  assert.equal(app.window.document.activeElement, updated.querySelector("summary"));
  app.dom.window.close();
});

test("legacy v1 revisions retain their saved evidence without joining same-day or null-source reflections", () => {
  const seed = setup();
  const fixture = seed.state();
  fixture.day = 3;
  fixture.inputDraft = "保存していた入力";
  const preference = fixture.memories.find((entry) => entry.id === "preference");
  preference.value = "後始末を減らすことを大切にしている";
  preference.source = "あとからつなぎ直す仕事を減らしたい";
  preference.day = 2;
  preference.revisions = [
    {
      value: "以前は変更の数を減らしたいと理解していた",
      source: "少ない変更なら安心できるかもしれない",
      day: 1,
    },
  ];
  fixture.journal.push(
    {
      id: "unrelated-null-current",
      day: 2,
      title: "別の出来事",
      text: "現在の理解とは無関係なnull出典の振り返り",
      sourceId: null,
    },
    {
      id: "unrelated-same-day",
      day: 1,
      title: "同じ日の別の出来事",
      text: "以前の理解とは無関係な同日の振り返り",
      sourceId: fixture.messages[0].id,
    },
  );
  const app = setup(JSON.stringify(fixture));
  app.click('[data-action="notebook"]');
  const history = app.query('[data-memory-revision="preference"]');
  history.open = true;
  assert.match(history.textContent, /少ない変更なら安心できるかもしれない/);
  assert.match(history.textContent, /以前は変更の数を減らしたいと理解していた/);
  assert.match(history.textContent, /あとからつなぎ直す仕事を減らしたい/);
  assert.doesNotMatch(history.textContent, /無関係/);
  assert.equal(history.querySelector('[data-action="message-source"]'), null);
  assert.equal(app.state().version, 1);
  assert.deepEqual(
    app.state().memories.find((entry) => entry.id === "preference"),
    preference,
  );
  assert.deepEqual(app.state().journal, fixture.journal);
  assert.equal(app.query("#message-input").value, "保存していた入力");
  for (const instance of [seed, app]) instance.dom.window.close();
});

test("understanding history follows the exact current source to its reflection and conversation", () => {
  const seed = setup();
  const correction = "PRをまとめるより、体験から考えてほしい";
  seed.send(correction);
  seed.advance(7000);
  seed.send("提案は少なめがいい");
  const fixture = seed.state();
  const preference = fixture.memories.find((entry) => entry.id === "preference");
  const reflection = fixture.journal.find((entry) => entry.sourceId === preference.sourceId);
  const unrelated = fixture.journal.at(-1);
  assert.ok(reflection);
  assert.equal(reflection.day, unrelated.day);
  assert.notEqual(reflection.sourceId, unrelated.sourceId);
  fixture.journal.push({
    id: "unrelated-null",
    day: preference.day,
    title: "無関係な記録",
    text: "同じ日でも関連しないnull出典の振り返り",
    sourceId: null,
  });
  const app = setup(JSON.stringify(fixture));
  app.click('[data-action="notebook"]');
  const history = app.query('[data-memory-revision="preference"]');
  history.open = true;
  assert.ok(history.textContent.includes(correction));
  assert.ok(history.textContent.includes(reflection.text));
  assert.equal(history.textContent.includes(unrelated.text), false);
  assert.doesNotMatch(history.textContent, /同じ日でも関連しない/);
  const links = history.querySelectorAll('[data-action="message-source"]');
  assert.equal(links.length, 1);
  assert.equal(links[0].dataset.message, preference.sourceId);
  links[0].click();
  assert.equal(app.query("#dialog").open, true);
  assert.match(app.query("#dialog-content").textContent, /あなた/);
  assert.ok(app.query("#dialog-content").textContent.includes(correction));
  assert.equal(app.query("#dialog-content").textContent.includes("提案は少なめがいい"), false);
  for (const instance of [seed, app]) instance.dom.window.close();
});
