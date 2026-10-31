/* Local interaction prototype. All work and outputs are sample data. */
const $ = (selector) => document.querySelector(selector);
const escapeHTML = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
  );
const paths = {
  micOff:
    "m3 3 18 18M9 9v3a3 3 0 0 0 5 2M9 5a3 3 0 0 1 6 0v4M5 10v2a7 7 0 0 0 12 5M19 10v2M12 19v3m-4 0h8",
  mic: "M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0ZM5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8",
  plus: "M12 5v14M5 12h14",
  arrow: "M5 12h14m-5-5 5 5-5 5",
  back: "M19 12H5m5-5-5 5 5 5",
  folder: "M3 7V5h6l2 2h10v12H3Z",
  document: "M6 3h8l4 4v14H6ZM14 3v5h4M9 12h6M9 16h6",
  code: "m8 6-6 6 6 6m8-12 6 6-6 6M14 4l-4 16",
  spark: "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z",
  check: "m5 12 4 4L19 6",
  chevron: "m8 10 4 4 4-4",
  pause: "M8 5v14M16 5v14",
  play: "m8 5 11 7-11 7Z",
  clock: "M12 7v5l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  close: "m6 6 12 12M6 18 18 6",
  repeat: "m17 2 4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4m14-1v2a3 3 0 0 1-3 3H3",
  download: "M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5",
  shield: "m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6ZM8 12l3 3 5-6",
  search: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14m5 12 6 6",
  menu: "M4 6h16M4 12h16M4 18h16",
  undo: "M3 10h11a7 7 0 0 1 0 14M3 10l6-6m-6 6 6 6",
  external: "M14 3h7v7m0-7L10 14M10 3H3v18h18v-7",
};
const icon = (name) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.spark}"/></svg>`;
const samples = {
  notes: {
    title: "メモを整理する",
    prompt: "メモを整理して、次にやることを3つにまとめて。",
    result: "今週のメモと次にやること",
    file: "next-steps.md",
    scope: "アイデアノート",
    description: "メモの要点と、すぐに取りかかれることをまとめます。",
    steps: [
      "関連するメモを読んでいます",
      "重なっている話題をまとめています",
      "次にやることを3つに絞っています",
    ],
    finished: "メモを整理しました。次にやることを3つにまとめています。",
    sections: [
      [
        "見えてきたこと",
        "今回のテーマは初回操作の簡略化です。やりたいことは明確なので、機能を増やす前に入口を整えます。",
      ],
      [
        "次にやること",
        [
          "最初の画面で必要な操作をひとつに絞る",
          "初めて使う人に説明なしで触ってもらう",
          "迷った箇所を記録して修正する",
        ],
      ],
      ["今回は見送ること", "細かな設定や継続実行は、最初の成功体験のあとで考えます。"],
    ],
  },
  code: {
    title: "使い始めのつまずきを減らす",
    prompt: "このプロジェクトで、使い始めにつまずくところを見つけて、改善案を作って。",
    result: "初回操作の改善案",
    file: "onboarding-review.md",
    scope: "Yorishiro",
    description: "はじめて使う人の目線で確認し、改善案をまとめます。",
    steps: [
      "初回の導線を確認しています",
      "迷いやすい操作を洗い出しています",
      "画面の改善案をまとめています",
    ],
    finished: "初回操作で迷いやすい箇所を3つ見つけました。改善案を確認してください。",
    sections: [
      [
        "いちばん大きなつまずき",
        "仕事を頼む前に設定が並び、何を選べば始められるかが見えにくくなっています。",
      ],
      [
        "改善するところ",
        [
          "よりに話しかけると、そのまま仕事の相談が始まる",
          "対象フォルダは今のワークスペースを引き継ぐ",
          "声を出せないときは、相談を文字へ切り替えて続ける",
        ],
      ],
      ["まず試すこと", "会話で依頼が形になり、同じ場所に成果が届く流れをHTMLで確かめます。"],
    ],
  },
  research: {
    title: "気になるテーマを調べる",
    prompt: "AIエージェントの使いやすさについて調べて、Yorishiroに取り入れる案をまとめて。",
    result: "おまかせ作業の改善案",
    file: "agent-ux-ideas.md",
    scope: "Yorishiro",
    description: "体験の参考を読み、プロジェクトに合う案にまとめます。",
    steps: [
      "参考になる事例を確認しています",
      "共通する体験を整理しています",
      "Yorishiroへの提案をまとめています",
    ],
    finished: "依頼、進行確認、成果の確認について改善案をまとめました。",
    sections: [
      [
        "参考にした体験",
        "Meta Museの公式デザイン記事では、継続した会話、活動の可視化、具体的な承認カード、用途に合う成果物が説明されています。",
      ],
      [
        "取り入れること",
        [
          "同じ入力欄から依頼と追加の指示ができる",
          "普段は今していることだけを短く伝える",
          "成果をその場で見せ、必要な判断だけを求める",
        ],
      ],
      ["Yorishiroらしさ", "VRMキャラクターを常設し、作業や会話の状態に合わせて視線を変えます。"],
    ],
  },
  custom: {
    title: "新しく任せたこと",
    result: "依頼を進めるための整理",
    file: "work-plan.md",
    description: "依頼を受け取り、進め方と成果の形を整理します。",
    steps: ["依頼の内容を確認しています", "進め方を整理しています", "確認できる形にまとめています"],
    finished:
      "依頼に沿って、最初に進めることをまとめました。内容を足したり、方向を変えたりできます。",
    sections: [
      ["進め方", "目的と対象を確認し、小さく試せる形を先につくります。"],
      [
        "次にやること",
        [
          "関連する資料と、いまの状態を確認する",
          "目的に近づく変更をひとつ試す",
          "結果を確かめて、次の一歩を提案する",
        ],
      ],
    ],
  },
};
const STORAGE_KEY = "yorishiro-omakase-prototype-v3";
const SCOPES = ["Yorishiro", "アイデアノート", "今週のプロジェクト"];
const initialTasks = () => [
  {
    id: "sample-review",
    kind: "code",
    title: "READMEを読みやすくする",
    prompt: "READMEの導入を読みやすくして",
    scope: "Yorishiro",
    status: "review",
    stage: 3,
    messages: [],
    needsApproval: true,
    createdAt: Date.now() - 3600000,
  },
  {
    id: "sample-notes",
    kind: "notes",
    title: "今週のメモを整理する",
    prompt: "今週のメモを整理して",
    scope: "アイデアノート",
    status: "done",
    stage: 3,
    messages: [],
    createdAt: Date.now() - 86400000,
  },
];
const labels = {
  running: "作業中",
  paused: "一時停止",
  done: "完了",
  review: "確認待ち",
  clarify: "相談中",
  failed: "中断",
  undone: "復元済み",
};
let state = { tasks: initialTasks(), scope: "Yorishiro", mode: "conversation" };
try {
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
  if (
    saved &&
    Array.isArray(saved.tasks) &&
    saved.tasks.every(
      (t) =>
        typeof t.id === "string" &&
        typeof t.title === "string" &&
        typeof t.prompt === "string" &&
        samples[t.kind] &&
        labels[t.status] &&
        Array.isArray(t.messages),
    )
  ) {
    state = {
      tasks: saved.tasks,
      scope: SCOPES.includes(saved.scope) ? saved.scope : "Yorishiro",
      mode: saved.mode === "quiet" ? "quiet" : "conversation",
    };
  }
} catch {
  /* Storage is optional for this local demo. */
}
let currentId = null;
let homeDraft = "";
const taskDrafts = {};
const timers = new Map();
let pendingRequest = null;
let latestUserTurn = "";
let composing = false;
let renderPending = false;
let dialogOpener;
let toastTimeout;
let conversation = { active: false, muted: false, phase: "idle", text: "" };
const task = () => state.tasks.find((t) => t.id === currentId);
const inConversation = () => state.mode === "conversation";
const canTalk = () => inConversation() && conversation.active && !conversation.muted;
const save = () => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {}
};
const announce = (text) => {
  $("#announcer").textContent = text;
};
function toast(text) {
  $("#toast").textContent = text;
  $("#toast").classList.add("visible");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => $("#toast").classList.remove("visible"), 3000);
}
function captureDraft() {
  if ($("#request")) homeDraft = $("#request").value;
  if ($("#followup") && currentId) taskDrafts[currentId] = $("#followup").value;
}
function renderIcons() {
  document.querySelectorAll("[data-icon]").forEach((el) => {
    el.innerHTML = icon(el.dataset.icon);
  });
}
function render() {
  if (composing) {
    renderPending = true;
    return;
  }
  const focused = document.activeElement;
  const id = focused?.matches("textarea") ? focused.id : null;
  const selection = id ? [focused.selectionStart, focused.selectionEnd] : null;
  $("#view").innerHTML = currentId ? taskHTML(task()) : homeHTML();
  $("#task-count").textContent = state.tasks.length;
  document.body.dataset.interaction = state.mode;
  document.querySelectorAll('[data-action="mode"]').forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.mode === state.mode));
  });
  renderIcons();
  updatePresence();
  renderDemoControls();
  if (id && document.getElementById(id)) {
    const input = document.getElementById(id);
    input.focus({ preventScroll: true });
    input.setSelectionRange(...selection);
  }
}
function contextHTML(scope) {
  return `<button class="workspace-context" data-action="scope">${icon("folder")}${escapeHTML(scope)}${icon("chevron")}</button>`;
}
function homeHTML() {
  if (pendingRequest && inConversation()) {
    const s = samples[pendingRequest.kind];
    return `<section class="home">${contextHTML(state.scope)}<p class="eyebrow">相談中</p><h1>${s.title}</h1><article class="request-draft"><div>${icon("document")}<span>${s.file}</span></div><p>${escapeHTML(pendingRequest.prompt)}</p></article>${inConversation() ? "" : `<div class="inline-question"><p>次にやることもまとめる？</p><button class="send" data-action="accept-request">それもお願い</button></div>`}</section>`;
  }
  return `<section class="home">${contextHTML(state.scope)}${inConversation() ? "" : `<h1>${pendingRequest ? "相談中の依頼" : "新しく頼む"}</h1>${composerHTML(false)}`}<section class="recent-work"><h${inConversation() ? "1" : "2"}>いまの仕事</h${inConversation() ? "1" : "2"}>${state.tasks
    .slice(0, 3)
    .map(
      (t) =>
        `<button class="work-row" data-action="open" data-id="${escapeHTML(t.id)}"><span class="work-row-icon">${icon(t.status === "review" ? "document" : t.status === "running" ? "clock" : "check")}</span><span class="work-row-title">${escapeHTML(t.title)}<small>${escapeHTML(t.scope)}</small></span><span class="work-row-state ${t.status === "review" ? "needs-review" : ""}">${labels[t.status]}</span>${icon("arrow")}</button>`,
    )
    .join("")}</section></section>`;
}
function composerHTML(followup) {
  const value = followup ? taskDrafts[currentId] || "" : homeDraft;
  return `<form class="composer ${followup ? "task-composer" : ""}" id="${followup ? "followup-form" : "new-task-form"}"><label class="sr-only" for="${followup ? "followup" : "request"}">${followup ? "追加の依頼" : "任せたいこと"}</label><textarea id="${followup ? "followup" : "request"}" maxlength="2000" placeholder="${followup ? "追加で頼む" : "今週のメモをまとめて"}">${escapeHTML(value)}</textarea><div class="composer-bottom"><button class="send" type="submit" ${value.trim() ? "" : "disabled"}>${followup ? "伝える" : "任せる"}${icon("arrow")}</button></div></form>`;
}
function taskHTML(t) {
  if (!t) return homeHTML();
  return `<section class="task-page"><div class="task-header"><button class="back-link" data-action="home">${icon("back")}いまの仕事</button>${contextHTML(t.scope)}</div><div class="task-heading"><h1>${escapeHTML(t.title)}</h1></div>${["running", "paused", "failed"].includes(t.status) ? workHTML(t) : t.status === "clarify" ? clarifyHTML(t) : artifactHTML(t)}${inConversation() ? "" : composerHTML(true)}<details class="conversation"><summary>やりとり</summary><div class="user-message">${escapeHTML(t.prompt)}</div>${t.messages.map((m) => `<div class="${m.role === "user" ? "user-message" : "assistant-message"}">${escapeHTML(m.text)}</div>`).join("")}</details></section>`;
}
function workHTML(t) {
  const paused = t.status === "paused",
    failed = t.status === "failed";
  return `<section class="work-card"><div class="work-top"><p class="work-current" role="status">${!paused && !failed ? '<span class="working-dot" aria-hidden="true"></span>' : ""}${failed ? "フォルダにアクセスできません" : paused ? "一時停止中" : samples[t.kind].steps[Math.min(t.stage, 2)]}</p><button class="secondary" data-action="${failed ? "retry" : paused ? "resume" : "pause"}">${icon(paused || failed ? "play" : "pause")}${failed ? "再試行" : paused ? "再開" : "止める"}</button></div>${failed ? '<button class="text-button" data-action="scope">フォルダを選び直す</button>' : `<div class="document-preview" aria-hidden="true"><span>${samples[t.kind].file}</span><i></i><i></i><i></i></div>`}</section>`;
}
function clarifyHTML() {
  return `<section class="work-card"><h2>どちらを進める？</h2><div class="choice-list"><button class="choice" data-action="answer" data-kind="notes">メモの整理</button><button class="choice" data-action="answer" data-kind="code">使いやすさの改善</button></div></section>`;
}
function artifactHTML(t) {
  const s = samples[t.kind],
    diff = t.needsApproval && !t.external;
  const body = t.shortened
    ? `<p class="artifact-callout">${diff ? "Yorishiroは、AIの住人と一緒に作業するデスクトップアプリです。" : "依頼の入口をひとつにまとめる。説明なしで使ってもらい、迷った操作を直す。"}</p>`
    : diff
      ? '<section class="artifact-section"><div class="diff-block"><div class="removed">− A terminal your AI dwells in.</div><div class="added">+ Yorishiroは、AIの住人と一緒に作業する<br>+ デスクトップアプリです。</div></div></section>'
      : s.sections
          .filter(([title]) => !t.summaryOnly || title !== "次にやること")
          .map(
            ([title, content]) =>
              `<section class="artifact-section"><h3>${title}</h3>${Array.isArray(content) ? `<ul>${content.map((x) => `<li>${x}</li>`).join("")}</ul>` : `<p>${content}</p>`}</section>`,
          )
          .join("");
  return `<article class="artifact" aria-label="成果物"><div class="artifact-bar"><span>${icon("document")}${diff ? "README.md" : s.file}</span><span>v${(t.revision || 0) + 1}</span></div><div class="artifact-paper"><h2>${diff ? "READMEの変更案" : s.result}</h2>${body}</div><div class="artifact-bottom">${t.status === "review" ? `<div class="review-target">${escapeHTML(t.external ? "GitHub · Yorishiro / Pull Request" : t.scope + "/README.md")}</div><div class="result-actions"><button class="send" data-action="approve">${t.external ? "公開する" : "反映する"}${icon("check")}</button><button class="text-button" data-action="decline">見送る</button></div>` : `<span>${t.status === "undone" ? "復元済み" : t.approved ? "反映済み" : t.declined ? "見送り" : "完成"}</span><div class="result-actions">${t.approved && !t.external ? '<button class="text-button" data-action="undo">元に戻す</button>' : ""}<button class="secondary" data-action="download">${icon("download")}保存</button></div>`}</div></article>`;
}
function classify(text) {
  if (/README/i.test(text)) return "code";
  if (/メモ|整理|資料|ノート/.test(text)) return "notes";
  if (/調べ|調査|比較|リサーチ/.test(text)) return "research";
  if (/プロジェクト|使いやす|改善|コード|バグ/.test(text)) return "code";
  return "custom";
}
function navigate(id) {
  captureDraft();
  window.yoriConversation?.cancelTurn();
  latestUserTurn = "";
  const nextHash = id ? `#task/${encodeURIComponent(id)}` : "#home";
  if (location.hash === nextHash) route();
  else location.hash = nextHash;
}
function route() {
  window.yoriConversation?.cancelTurn();
  let id = null;
  try {
    if (location.hash.startsWith("#task/")) id = decodeURIComponent(location.hash.slice(6));
  } catch {}
  currentId = state.tasks.some((t) => t.id === id) ? id : null;
  latestUserTurn = "";
  render();
  window.scrollTo({ top: 0 });
}
function startTask(prompt, options = {}) {
  const kind = classify(prompt);
  const t = {
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    kind,
    title:
      kind === "custom"
        ? prompt.slice(0, 26)
        : /README/i.test(prompt)
          ? "READMEを読みやすくする"
          : samples[kind].title,
    prompt,
    scope: state.scope,
    status: prompt.trim().length < 8 ? "clarify" : "running",
    stage: 0,
    messages: [],
    createdAt: Date.now(),
    needsApproval: /README/i.test(prompt) || /公開/.test(prompt),
    external: /公開/.test(prompt),
    ...options,
  };
  state.tasks.unshift(t);
  homeDraft = "";
  pendingRequest = null;
  save();
  navigate(t.id);
  schedule(t);
  window.yoriCharacter?.acknowledge();
  announce("依頼を受け取りました");
  return t;
}
function schedule(t) {
  clearTimeout(timers.get(t.id));
  if (t.status !== "running") return;
  timers.set(
    t.id,
    setTimeout(() => {
      if (t.status !== "running") return;
      t.stage++;
      if (t.stage >= 3) {
        finish(t);
        return;
      }
      save();
      if (currentId === t.id) {
        captureDraft();
        render();
      }
      schedule(t);
    }, 3600),
  );
}
function finish(t) {
  clearTimeout(timers.get(t.id));
  timers.delete(t.id);
  t.stage = 3;
  t.status = t.needsApproval && !t.approved && !t.declined ? "review" : "done";
  save();
  captureDraft();
  render();
  if (currentId !== t.id) toast(`「${t.title}」が完了`);
  else if (canTalk() && conversation.phase === "listening")
    window.yoriConversation.respond(t.status === "review" ? "変更案ができたよ。" : "できたよ。");
  announce(labels[t.status]);
}
function sendFollowup(text) {
  const t = task();
  if (!t) return;
  t.messages.push({ role: "user", text });
  taskDrafts[t.id] = "";
  if (/止め|停止|休ん/.test(text)) {
    clearTimeout(timers.get(t.id));
    t.status = "paused";
    t.messages.push({ role: "assistant", text: "ここで止めるね。" });
  } else {
    t.shortened = /短く|簡潔|要約|一文/.test(text) || t.shortened;
    t.messages.push({
      role: "assistant",
      text: t.shortened ? "短くまとめ直すね。" : "それも含めて進めるね。",
    });
    t.revision = (t.revision || 0) + 1;
    t.stage = 1;
    t.status = "running";
    t.approved = false;
    t.declined = false;
    schedule(t);
  }
  save();
  render();
}
function setMode(mode) {
  if (state.mode === mode) return;
  captureDraft();
  state.mode = mode === "quiet" ? "quiet" : "conversation";
  if (pendingRequest && !currentId) {
    if (state.mode === "quiet") homeDraft = pendingRequest.prompt;
    else if (state.mode === "conversation") {
      if (homeDraft.trim()) {
        pendingRequest.prompt = homeDraft.trim();
        pendingRequest.kind = classify(homeDraft);
      } else pendingRequest = null;
    }
  }
  window.yoriConversation?.end();
  latestUserTurn = "";
  save();
  render();
  if (state.mode === "quiet") document.getElementById(currentId ? "followup" : "request")?.focus();
}
function startConversation() {
  if (!inConversation()) return;
  window.yoriConversation?.start();
  window.yoriConversation?.respond(
    task()
      ? "どうしようか？"
      : pendingRequest
        ? "次にやることもまとめる？"
        : "今日は何を進めようか？",
  );
}
function demoTurn(action) {
  if (!canTalk() || !window.yoriConversation?.interrupt()) return;
  const t = task();
  if (action === "notes") {
    latestUserTurn = "今週のメモをまとめて";
    pendingRequest = { kind: "notes", prompt: latestUserTurn };
    homeDraft = latestUserTurn;
    render();
    window.yoriConversation.respond("次にやることもまとめる？");
  } else if (action === "readme") {
    latestUserTurn = "READMEを読みやすくして";
    pendingRequest = { kind: "code", prompt: latestUserTurn };
    homeDraft = latestUserTurn;
    render();
    window.yoriConversation.respond("冒頭の説明を整えて、変更案を見せるね。", () =>
      startTask("READMEを読みやすくして"),
    );
  } else if (action === "accept" || action === "summary") {
    latestUserTurn = action === "accept" ? "うん、それもお願い" : "要点だけでいい";
    renderDemoControls();
    window.yoriConversation.respond(
      action === "accept"
        ? "わかった。メモと次にやることをまとめるね。"
        : "わかった。要点をまとめるね。",
      () => acceptRequest(action === "summary"),
    );
  } else if (action === "progress" && t) {
    latestUserTurn = "どこまで進んだ？";
    renderDemoControls();
    window.yoriConversation.respond(
      t.status === "running"
        ? samples[t.kind].steps[Math.min(t.stage, 2)]
        : t.status === "paused"
          ? "いまは止めているよ。"
          : "できているよ。隣に置いておいた。",
    );
  } else if (action === "shorten" && t) {
    latestUserTurn = "もっと短くして";
    sendFollowup(latestUserTurn);
    window.yoriConversation.respond("短くまとめ直すね。");
  } else if (action === "stop" && t) {
    latestUserTurn = "いったん止めて";
    sendFollowup(latestUserTurn);
    window.yoriConversation.respond("ここで止めるね。");
  } else if (action === "resume" && t) {
    latestUserTurn = "続けて";
    t.status = "running";
    save();
    render();
    schedule(t);
    window.yoriConversation.respond("続きを進めるね。");
  } else if (action === "thanks") {
    latestUserTurn = "ありがとう";
    renderDemoControls();
    window.yoriConversation.respond("また何かあれば声をかけてね。", () =>
      window.yoriConversation.end(),
    );
  }
}
function acceptRequest(summaryOnly = false) {
  if (!pendingRequest) return;
  startTask(
    summaryOnly ? pendingRequest.prompt : `${pendingRequest.prompt}。次にやることもまとめて`,
    { summaryOnly },
  );
}
function renderDemoControls() {
  const target = $("#demo-conversation");
  if (!inConversation() || !conversation.active) {
    target.hidden = true;
    target.innerHTML = "";
    return;
  }
  target.hidden = false;
  const t = task();
  const choices = !t
    ? pendingRequest
      ? [
          ["accept", "うん、それもお願い"],
          ["summary", "要点だけでいい"],
        ]
      : [
          ["notes", "今週のメモをまとめて"],
          ["readme", "READMEを読みやすくして"],
        ]
    : t.status === "running"
      ? [
          ["progress", "どこまで進んだ？"],
          ["stop", "いったん止めて"],
        ]
      : t.status === "paused"
        ? [["resume", "続けて"]]
        : [
            ["shorten", "もっと短くして"],
            ["thanks", "ありがとう"],
          ];
  target.innerHTML = `<div class="demo-label">発話サンプル</div><div class="demo-utterances">${choices.map(([action, text]) => `<button data-action="demo-turn" data-turn="${action}" ${conversation.muted ? "disabled" : ""}>${text}${icon("arrow")}</button>`).join("")}</div>`;
}
function updatePresence() {
  const t = task();
  const working = t?.status === "running";
  const mode =
    conversation.active && !conversation.muted
      ? conversation.phase
      : working
        ? "working"
        : t?.status === "review"
          ? "review"
          : t?.status === "done"
            ? "done"
            : "idle";
  window.yoriCharacter?.setState(mode);
  document.body.dataset.mode = mode;
  const phaseLabels = {
    idle: "",
    listening: "聞いています",
    thinking: "考えています",
    speaking: "話しています",
    muted: "ミュート中",
  };
  $("#presence-state").textContent = conversation.active ? phaseLabels[conversation.phase] : "";
  $("#presence-speech").textContent = conversation.active ? conversation.text || "" : "";
  $("#presence-controls").innerHTML = !inConversation()
    ? ""
    : conversation.active
      ? `<div class="call-controls"><button class="call-icon ${conversation.muted ? "is-muted" : ""}" data-action="mute" aria-pressed="${conversation.muted}" aria-label="${conversation.muted ? "ミュートを解除" : "ミュート"}" title="${conversation.muted ? "ミュートを解除" : "ミュート"}">${icon(conversation.muted ? "micOff" : "mic")}</button><button class="call-end" data-action="end-conversation">会話を終了${icon("close")}</button></div><span class="call-demo-label">会話デモ</span>`
      : `<button class="talk-primary" data-action="start-conversation">${icon("mic")}話しかける</button>`;
}
window.addEventListener("yorishiro:conversation", ({ detail }) => {
  conversation = detail;
  updatePresence();
  renderDemoControls();
});
function modal(title, body, actions = "") {
  window.yoriConversation?.cancelTurn();
  dialogOpener = document.activeElement;
  $("#dialog-content").innerHTML =
    `<div class="dialog-inner"><div class="dialog-top"><h2 id="dialog-title">${title}</h2><button class="icon-button" data-action="close-dialog" aria-label="閉じる">${icon("close")}</button></div>${body}${actions ? `<div class="dialog-actions">${actions}</div>` : ""}</div>`;
  if (!$("#dialog").open) $("#dialog").showModal();
}
function closeDialog() {
  if ($("#dialog").open) $("#dialog").close();
  if (dialogOpener?.isConnected) dialogOpener.focus();
}
function showHistory() {
  modal(
    "作業履歴",
    `<div class="history-list">${state.tasks.map((t) => `<button class="work-row" data-action="open" data-id="${escapeHTML(t.id)}"><span class="work-row-title">${escapeHTML(t.title)}</span><span class="work-row-state">${labels[t.status]}</span>${icon("arrow")}</button>`).join("")}</div>`,
  );
}
function showScope() {
  modal(
    "作業するフォルダ",
    SCOPES.map(
      (scope) =>
        `<button class="folder-option" data-action="choose-scope" data-scope="${scope}">${icon("folder")}${scope}</button>`,
    ).join(""),
  );
}
function showAbout() {
  modal(
    "体験デモ",
    '<div class="dialog-copy"><p>会話と仕事はサンプルです。GPT Liveには接続せず、マイクも使いません。</p><p>発話サンプルを選ぶと会話が進みます。よりの声はブラウザの読み上げです。</p></div>',
    '<button class="text-button" data-action="reset">最初に戻す</button><button class="send" data-action="close-dialog">閉じる</button>',
  );
}
function showStrategy() {
  modal(
    "設計の方針",
    '<div class="dialog-copy"><h3>任せる内容と結果に集中する</h3><p>会話から依頼が形になり、同じ場所で成果になる。設定画面へ内容を転記させない。</p><h3>使う状況をひとつ選ぶ</h3><p>「話しながら」は音声対話。「静かに」は文字。声、入力欄、返答の出し方をまとめて切り替え、仕事は引き継ぐ。</p><h3>よりは会話の相手</h3><p>聞く、考える、話すを身体と声で示す。資料には成果と判断に必要な情報だけを置く。</p><h3>会話と作業は別々に続く</h3><p>会話を終えても任せた仕事は続く。仕事を止めるときはその仕事を止める。モード切り替えで権限は変えない。</p></div>',
  );
}
function download() {
  const t = task();
  if (!t) return;
  const s = samples[t.kind];
  const text =
    t.needsApproval && !t.external
      ? `# README\n\nYorishiroは、AIの住人と一緒に作業するデスクトップアプリです。`
      : `# ${s.result}\n\n${
          t.shortened
            ? "依頼の入口をひとつにまとめる。説明なしで使ってもらい、迷った操作を直す。"
            : s.sections
                .filter(([title]) => !t.summaryOnly || title !== "次にやること")
                .map(
                  ([title, content]) =>
                    `## ${title}\n\n${Array.isArray(content) ? content.map((x) => "- " + x).join("\n") : content}`,
                )
                .join("\n\n")
        }`;
  const url = URL.createObjectURL(
    new Blob(
      [
        `${text}\n\n---\nYorishiro体験デモのサンプルです。実ファイルの調査・変更は行っていません。\n`,
      ],
      { type: "text/markdown;charset=utf-8" },
    ),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = t.needsApproval && !t.external ? "readme-draft.md" : s.file;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function simulate(kind) {
  const t = task();
  if (!t) return;
  clearTimeout(timers.get(t.id));
  t.status = kind;
  if (kind === "review") {
    t.needsApproval = true;
    t.external = false;
    t.approved = false;
    t.declined = false;
  }
  save();
  closeDialog();
  render();
}
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button || button.disabled) return;
  const action = button.dataset.action,
    t = task();
  captureDraft();
  if (action === "mode") setMode(button.dataset.mode);
  else if (action === "start-conversation") startConversation();
  else if (action === "end-conversation") window.yoriConversation?.end();
  else if (action === "mute") window.yoriConversation?.toggleMute();
  else if (action === "demo-turn") demoTurn(button.dataset.turn);
  else if (action === "accept-request") acceptRequest();
  else if (action === "home") navigate(null);
  else if (action === "open") {
    closeDialog();
    navigate(button.dataset.id);
  } else if (action === "history") showHistory();
  else if (action === "scope") showScope();
  else if (action === "choose-scope") {
    if (t) t.scope = button.dataset.scope;
    else state.scope = button.dataset.scope;
    save();
    closeDialog();
    render();
  } else if (action === "about") showAbout();
  else if (action === "strategy") showStrategy();
  else if (action === "close-dialog") closeDialog();
  else if (action === "download") download();
  else if (action === "pause" && t) {
    clearTimeout(timers.get(t.id));
    t.status = "paused";
    save();
    render();
  } else if ((action === "resume" || action === "retry") && t) {
    t.status = "running";
    save();
    render();
    schedule(t);
  } else if (action === "answer" && t) {
    t.kind = button.dataset.kind;
    t.title = samples[t.kind].title;
    t.status = "running";
    t.stage = 0;
    save();
    render();
    schedule(t);
  } else if (action === "approve" && t) {
    t.approved = true;
    t.status = "done";
    save();
    render();
    toast(t.external ? "公開操作を体験しました（デモ）" : "反映しました（デモ）");
  } else if (action === "decline" && t) {
    t.declined = true;
    t.status = "done";
    save();
    render();
  } else if (action === "undo" && t) {
    t.approved = false;
    t.status = "undone";
    save();
    render();
  } else if (action === "scenes")
    modal(
      "場面を試す",
      '<div class="choice-list"><button class="choice" data-action="scene" data-scene="clarify">相談</button><button class="choice" data-action="scene" data-scene="review">変更の確認</button><button class="choice" data-action="scene" data-scene="failed">中断</button></div>',
    );
  else if (action === "scene") {
    if (t) simulate(button.dataset.scene);
    else {
      closeDialog();
      toast("仕事を開いてから選んでください");
    }
  } else if (action === "reset") {
    window.yoriConversation?.end();
    timers.forEach(clearTimeout);
    timers.clear();
    state = { tasks: initialTasks(), scope: "Yorishiro", mode: "conversation" };
    homeDraft = "";
    pendingRequest = null;
    latestUserTurn = "";
    Object.keys(taskDrafts).forEach((key) => {
      delete taskDrafts[key];
    });
    save();
    closeDialog();
    navigate(null);
  }
});
document.addEventListener("compositionstart", () => {
  composing = true;
});
document.addEventListener("compositionend", () => {
  composing = false;
  captureDraft();
  if (renderPending) {
    renderPending = false;
    render();
  }
});
document.addEventListener("input", (event) => {
  if (!event.target.matches(".composer textarea")) return;
  captureDraft();
  event.target.closest("form").querySelector(".send").disabled = !event.target.value.trim();
});
document.addEventListener("submit", (event) => {
  if (!event.target.matches(".composer")) return;
  event.preventDefault();
  const value = event.target.querySelector("textarea").value.trim();
  if (!value || composing) return;
  if (event.target.id === "new-task-form") startTask(value);
  else sendFollowup(value);
});
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !event.isComposing) {
    const form = event.target.closest("form");
    if (form) {
      event.preventDefault();
      form.requestSubmit();
    }
  }
  if (event.key === "Escape" && !$("#dialog").open) window.yoriConversation?.end();
});
$("#dialog").addEventListener("cancel", (event) => {
  event.preventDefault();
  closeDialog();
});
window.addEventListener("yorishiro:character-ready", ({ detail }) => {
  document.body.classList.toggle("character-ready", detail.ok);
  document.body.classList.toggle("character-error", !detail.ok);
  if (!detail.ok) $("#character-load").textContent = "3D表示を読み込めませんでした";
  updatePresence();
});
window.addEventListener("hashchange", route);
route();
state.tasks.filter((t) => t.status === "running").forEach(schedule);
