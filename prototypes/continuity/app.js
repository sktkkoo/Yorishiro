/* Local experience prototype: all conversation branches, work and days are fictional.
 * No model, microphone, repository, external service or user file is connected.
 */
(() => {
  const KEY = "yorishiro-continuity-prototype-v1";
  const VERSION = 1;
  const $ = (selector) => document.querySelector(selector);
  const escapeHTML = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (char) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[char],
    );
  const arrow =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15m-5-5 5 5-5 5"/></svg>';
  const closeIcon =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg>';
  const flow = $(".conversation-flow");
  const log = $("#conversation-log");
  const input = $("#message-input");
  const notebook = $("#notebook");
  const dialog = $("#dialog");
  const initialConcern = "初めて開いた人が、何から始めればいいか迷うこと。";
  let state;
  let epoch = 0;
  let pendingTimer = null;
  let timerStartedAt = 0;
  let remaining = 0;
  let toastTimer = null;
  let dialogOpener = null;
  let correctionId = null;
  let composing = false;
  let saveWarningShown = false;
  let unreadReply = false;
  let notebookHtml = "";
  const renderedMessages = new Map();
  const newReplyButton = document.createElement("button");
  newReplyButton.type = "button";
  newReplyButton.id = "new-reply";
  newReplyButton.className = "text-button";
  newReplyButton.dataset.action = "latest";
  newReplyButton.textContent = "新しい返事 ↓";
  newReplyButton.hidden = true;
  $(".composer-area").prepend(newReplyButton);
  const quietPreference = (text) => /提案.*少な|提案.*控え|静かに/.test(text);
  const normalPreference = (text) => /また提案して|提案していい|いつも通り/.test(text);

  function dayLabel(day) {
    const elapsed = state.day - day;
    return elapsed === 0 ? "今日" : elapsed === 1 ? "昨日" : `${elapsed}日前`;
  }
  function message(role, text, artifact = null, extra = {}) {
    const item = {
      id: `message-${++state.sequence}`,
      role,
      text,
      day: state.day,
      artifact,
      ...(artifact === "quiet-note" ? { artifactState: state.draft } : {}),
      ...extra,
    };
    state.messages.push(item);
    state.messages = state.messages.slice(-100);
    return item;
  }
  function journal(title, text, sourceId = null) {
    state.journal.push({
      id: `journal-${++state.sequence}`,
      day: state.day,
      title,
      text,
      sourceId,
    });
    state.journal = state.journal.slice(-40);
  }
  function recordMemory(id, title, value, source, sourceId = null, certainty = "会話で聞いたこと") {
    const previous = state.memories.find((entry) => entry.id === id);
    if (previous && previous.value === value) return;
    const memory = {
      id,
      title,
      value,
      source,
      sourceId,
      day: state.day,
      certainty,
      revisions: previous
        ? [
            ...previous.revisions,
            {
              value: previous.value,
              source: previous.source,
              sourceId: previous.sourceId,
              certainty: previous.certainty,
              day: previous.day,
            },
          ].slice(-5)
        : [],
    };
    if (previous) state.memories[state.memories.indexOf(previous)] = memory;
    else state.memories.push(memory);
    state.memories = state.memories.slice(-20);
  }
  function createScene(scene) {
    unreadReply = false;
    state = {
      version: VERSION,
      scene,
      day: 1,
      sequence: 0,
      messages: [],
      memories: [],
      journal: [],
      direction: scene === "first" ? "unknown" : "grouping",
      initiative: scene === "quiet" ? "quiet" : "normal",
      withdrawn: false,
      draft: "none",
      feedback: false,
      concern: scene === "first" ? "" : initialConcern,
      inputDraft: "",
      openedArtifact: false,
    };
    if (scene === "first") {
      message("assistant", "はじめまして、よりです。今日は何をしてた？");
      journal(
        "はじめて会った",
        "まだ、相手が何を大切にしているかは知らない。まずは今日の話を聞いてみたい。",
      );
      return;
    }
    state.memories = [
      {
        id: "preference",
        title: "大切にしていること",
        value: "細かな改善がばらばらに増えると、全体を見渡しにくい。",
        source: "細かなPRが増えて、全体が見えないんだよね。",
        sourceId: null,
        day: 0,
        certainty: "前の会話（サンプル）",
        revisions: [],
      },
      {
        id: "background",
        title: "その背景",
        value: "重なった変更やコンフリクトの後始末が、自分の仕事になっている。",
        source: "任せたはずなのに、最後は自分でつなぎ直している感じがする。",
        sourceId: null,
        day: 0,
        certainty: "前の会話（サンプル）",
        revisions: [],
      },
      {
        id: "scope",
        title: "任されている範囲",
        value: "資料を見ることと、手元で草案をつくること。公開する前には一緒に見る。",
        source: "資料を見たり草案を作るところまで。公開は先に見たい。",
        sourceId: null,
        day: 0,
        certainty: "サンプルの会話で確認",
        revisions: [],
      },
      {
        id: "interpretation",
        title: "まだ確かめたいこと",
        value: "同じ問題につながる変更をまとめて見ると、少し楽になるかもしれない。",
        source: "昨日の困り事と、3つの変更を見比べて。",
        sourceId: null,
        day: 1,
        certainty: "よりの仮説",
        revisions: [],
      },
    ];
    state.journal.push({
      id: "journal-yesterday",
      day: 0,
      title: "PRの後始末",
      text: "細かなPRが増え、統合を本人がやり直していると聞いた。",
      sourceId: null,
    });
    if (scene === "quiet") {
      recordMemory(
        "initiative",
        "声をかけるタイミング",
        "提案は控えめに。話したくなったときに、一緒に続きを考える。",
        "今日は静かに過ごしたい。提案は少なめがいい。",
        null,
      );
      message("assistant", "おかえり。");
      journal("提案を控える", "今日は静かに過ごしたいと聞いた。こちらからの提案は控える。");
    } else {
      message(
        "assistant",
        "おかえり。昨日の「細かなPRが増えて、全体が見えない」が気になって、3つの変更を見比べたよ。\nどれも使い始めに迷うところだった。一緒に見る？",
        "grouping",
        { origin: true },
      );
      journal(
        "同じつまずきが見えてきた",
        "3つの変更は使い始めの迷いに関わっていた。まとめて見る案を出した。",
      );
    }
  }
  function validString(value, max = 8000) {
    return typeof value === "string" && value.length <= max;
  }
  function validState(value) {
    return (
      value &&
      value.version === VERSION &&
      ["return", "first", "quiet"].includes(value.scene) &&
      Number.isInteger(value.day) &&
      value.day >= 1 &&
      value.day <= 10000 &&
      Number.isInteger(value.sequence) &&
      value.sequence >= 0 &&
      ["unknown", "grouping", "experience", "custom"].includes(value.direction) &&
      ["normal", "quiet"].includes(value.initiative) &&
      ["none", "working", "ready", "interrupted"].includes(value.draft) &&
      typeof value.withdrawn === "boolean" &&
      typeof value.feedback === "boolean" &&
      validString(value.concern) &&
      validString(value.inputDraft, 2000) &&
      typeof value.openedArtifact === "boolean" &&
      Array.isArray(value.messages) &&
      value.messages.length <= 100 &&
      value.messages.every(
        (item) =>
          item &&
          validString(item.id, 100) &&
          ["user", "assistant"].includes(item.role) &&
          validString(item.text) &&
          Number.isInteger(item.day) &&
          item.day >= 1 &&
          [null, "grouping", "journey", "quiet-note"].includes(item.artifact) &&
          (item.artifactState === undefined ||
            ["none", "working", "ready", "interrupted"].includes(item.artifactState)) &&
          (item.origin === undefined || typeof item.origin === "boolean") &&
          (item.note === undefined || validString(item.note)),
      ) &&
      Array.isArray(value.memories) &&
      value.memories.length <= 20 &&
      value.memories.every(
        (item) =>
          item &&
          validString(item.id, 100) &&
          validString(item.title, 200) &&
          validString(item.value) &&
          validString(item.source) &&
          validString(item.certainty, 200) &&
          (item.sourceId === null || validString(item.sourceId, 100)) &&
          Number.isInteger(item.day) &&
          Array.isArray(item.revisions) &&
          item.revisions.length <= 5 &&
          item.revisions.every(
            (old) =>
              old &&
              validString(old.value) &&
              validString(old.source) &&
              Number.isInteger(old.day) &&
              (old.sourceId === undefined ||
                old.sourceId === null ||
                validString(old.sourceId, 100)) &&
              (old.certainty === undefined || validString(old.certainty, 200)),
          ),
      ) &&
      Array.isArray(value.journal) &&
      value.journal.length <= 40 &&
      value.journal.every(
        (item) =>
          item &&
          validString(item.id, 100) &&
          validString(item.title, 200) &&
          validString(item.text) &&
          Number.isInteger(item.day) &&
          (item.sourceId === null || validString(item.sourceId, 100)),
      )
    );
  }
  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      return true;
    } catch {
      if (!saveWarningShown) {
        saveWarningShown = true;
        toast("このブラウザでは保存できません。このページを開いている間だけ続きます。");
      }
      return false;
    }
  }
  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (validState(parsed)) {
          state = parsed;
          if (state.draft === "working") {
            state.draft = "interrupted";
            message(
              "assistant",
              "前の続きは残っているよ。画面を閉じたとき、草案はまだ途中だった。",
              null,
              { note: "デモの作業は、ページを開いている間だけ進みます。" },
            );
          }
          return;
        }
      }
    } catch {
      /* Invalid or unavailable local state starts a clean sample. */
    }
    createScene("return");
  }
  function toast(text) {
    clearTimeout(toastTimer);
    $("#toast").textContent = text;
    toastTimer = setTimeout(() => {
      $("#toast").textContent = "";
    }, 4200);
  }
  function cancelDraft() {
    epoch++;
    clearTimeout(pendingTimer);
    pendingTimer = null;
    remaining = 0;
    if (state.draft === "working") state.draft = "interrupted";
  }
  function beginDraft() {
    if (state.withdrawn || state.draft === "working" || state.draft === "ready") return;
    cancelDraft();
    state.draft = "working";
    remaining = 7000;
    scheduleDraft();
    save();
  }
  function scheduleDraft() {
    if (
      document.visibilityState === "hidden" ||
      state.draft !== "working" ||
      !remaining ||
      pendingTimer !== null
    )
      return;
    const currentEpoch = epoch;
    timerStartedAt = Date.now();
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      if (currentEpoch !== epoch || state.withdrawn || state.draft !== "working") return;
      if (document.visibilityState === "hidden") {
        remaining = 1;
        return;
      }
      remaining = 0;
      state.draft = "ready";
      const result =
        state.initiative === "quiet"
          ? null
          : message("assistant", "起動してから翌日まで、4つの場面にしてみたよ。", "journey");
      journal(
        "体験の草案",
        "起動から翌日までの草案を作った。反応はまだ聞いていない。" +
          (state.initiative === "quiet"
            ? "提案は控えめに、という希望に合わせて通知はしなかった。"
            : ""),
        result?.id ?? null,
      );
      render({ follow: result !== null });
      save();
      window.yoriCharacter?.acknowledge();
    }, remaining);
  }
  function artifact(kind, item) {
    if (kind === "grouping")
      return `<section class="artifact-card" aria-label="よりの提案">
      <h3>使い始めの3つの変更</h3>
      <p>入口の説明・設定・作業の開始</p>
      <div class="message-actions"><button type="button" class="suggestion-button" data-action="view-artifact" data-kind="grouping">一緒に見る ${arrow}</button></div>
      </section>`;
    if (kind === "journey")
      return `<section class="artifact-card" aria-label="体験の草案">
      <h3>起動から翌日までの草案</h3>
      <div class="message-actions"><button type="button" class="suggestion-button" data-action="view-artifact" data-kind="journey">草案をひらく ${arrow}</button></div></section>`;
    if (kind === "quiet-note")
      return `<section class="artifact-card" aria-label="続きを見る">
      <h3>${item.artifactState === "ready" ? "体験の草案" : ["working", "interrupted"].includes(item.artifactState) ? "考えかけのメモ" : "前に話したこと"}</h3>
      <div class="message-actions">${item.artifactState === "ready" ? `<button type="button" class="text-button" data-action="view-artifact" data-kind="journey">草案を見る ${arrow}</button>` : `<button type="button" class="text-button" data-action="notebook">いまの理解を見る ${arrow}</button>`}</div></section>`;
    return "";
  }
  function renderMessages() {
    let previousDay = null;
    const expected = [];
    for (const item of state.messages) {
      if (item.day !== previousDay) {
        const key = `day-${item.day}`;
        let record = renderedMessages.get(key);
        if (!record) {
          const node = document.createElement("div");
          node.className = "day-divider";
          record = { node, html: "" };
          renderedMessages.set(key, record);
        }
        const label = dayLabel(item.day);
        if (record.node.textContent !== label) record.node.textContent = label;
        expected.push(record.node);
        previousDay = item.day;
      }
      const html = `<div class="message-meta">${item.role === "assistant" ? '<span class="message-avatar" aria-hidden="true">よ</span>' : ""}<strong>${item.role === "assistant" ? "より" : "あなた"}</strong></div>
        <p class="message-content">${escapeHTML(item.text)}</p>${artifact(item.artifact, item)}
        ${item.origin ? '<button type="button" class="memory-origin" data-action="origin">この提案のきっかけ</button>' : ""}
        ${item.note ? `<p class="feedback-note">${escapeHTML(item.note)}</p>` : ""}`;
      let record = renderedMessages.get(item.id);
      if (!record) {
        const node = document.createElement("article");
        node.className = "message";
        node.id = item.id;
        record = { node, html: "" };
        renderedMessages.set(item.id, record);
      }
      record.node.dataset.role = item.role;
      if (record.html !== html) {
        record.node.innerHTML = html;
        record.html = html;
      }
      expected.push(record.node);
    }
    // Leave unchanged message nodes in place. Focus and live-region history
    // survive background status updates; only actual new messages are added.
    const keep = new Set(expected);
    for (const child of [...log.children]) if (!keep.has(child)) child.remove();
    expected.forEach((node, index) => {
      if (log.children[index] !== node) log.insertBefore(node, log.children[index] ?? null);
    });
    for (const [key, record] of renderedMessages)
      if (!keep.has(record.node)) renderedMessages.delete(key);
    const status =
      state.draft === "working"
        ? '<p class="typing-indicator" role="status" aria-label="草案を作成中"><span></span><span></span><span></span></p>'
        : "";
    if ($("#story-detail").innerHTML !== status) $("#story-detail").innerHTML = status;
  }
  function replies() {
    if (state.withdrawn) return ["理由も覚えておいて", "今日は別のことを話したい"];
    if (state.initiative === "quiet")
      return ["今どんなことを覚えている？", "今日は別のことを話したい"];
    if (state.scene === "first" && state.direction === "unknown")
      return ["細かな改善ばかりで、全体が見えない", "まずは話しながら知ってほしい"];
    if (state.draft === "ready")
      return ["こういう方向がいい", "提案は少なめがいい", "理由も覚えておいて"];
    if (state.direction === "experience" && state.draft === "interrupted")
      return ["草案の続きを見せて", "今は話すだけにしたい", "理由も覚えておいて"];
    if (state.direction === "experience")
      return ["理由も覚えておいて", "提案は少なめがいい", "今は話すだけにしたい"];
    return ["PRをまとめるより、体験から考えてほしい", "まず見せて", "今は話すだけにしたい"];
  }
  function understandingHistory(entry) {
    const snapshots = [...entry.revisions, entry].reverse();
    return `<ol class="understanding-history">${snapshots
      .map((snapshot, index) => {
        // Older saves have no revision sourceId. Keep their saved quote,
        // without guessing a relationship from a shared date or null ID.
        const source = snapshot.sourceId
          ? state.messages.find((item) => item.id === snapshot.sourceId)
          : null;
        const reflection = snapshot.sourceId
          ? state.journal.find((item) => item.sourceId === snapshot.sourceId)
          : null;
        return `<li><small>${escapeHTML(dayLabel(snapshot.day))}${snapshot.certainty ? ` · ${escapeHTML(snapshot.certainty)}` : ""}</small>
          <blockquote>${escapeHTML(snapshot.source)}</blockquote>
          ${index > 0 ? `<p class="previous-understanding"><span>以前の理解</span>${escapeHTML(snapshot.value)}</p>` : ""}
          ${reflection ? `<p>${escapeHTML(reflection.text)}</p>` : ""}
          ${source ? `<div class="memory-evidence"><button type="button" data-action="message-source" data-message="${escapeHTML(source.id)}">このときの会話</button></div>` : ""}</li>`;
      })
      .join("")}</ol>`;
  }
  function renderNotebook() {
    const container = $("#notebook-content");
    const expanded = new Set(
      [...container.querySelectorAll("details[open]")].map((node) => node.dataset.memoryRevision),
    );
    const focused = container.contains(document.activeElement) ? document.activeElement : null;
    const focusedAction = focused ? { ...focused.dataset } : null;
    const focusedRevision = focused?.closest("[data-memory-revision]")?.dataset.memoryRevision;
    const scrollTop = notebook.scrollTop;
    const html = state.memories.length
      ? state.memories
          .map(
            (
              entry,
            ) => `<article class="notebook-entry"><h3>${escapeHTML(entry.title)}</h3><p>${escapeHTML(entry.value)}</p>
              ${/仮説|確かめたい/.test(entry.certainty) ? `<small class="understanding-certainty">${escapeHTML(entry.certainty)}</small>` : ""}
              <details class="memory-revision" data-memory-revision="${escapeHTML(entry.id)}"><summary>そう理解した経緯</summary>${understandingHistory(entry)}</details>
              <button type="button" class="text-button" data-action="correct-memory" data-memory="${escapeHTML(entry.id)}">訂正する</button></article>`,
          )
          .join("")
      : '<section class="notebook-entry"><p>まだ記録はありません。</p></section>';
    if (notebookHtml === html) return;
    container.innerHTML = html;
    notebookHtml = html;
    for (const node of container.querySelectorAll("details"))
      node.open = expanded.has(node.dataset.memoryRevision);
    if (focused) {
      const replacement =
        focusedRevision && focused.tagName === "SUMMARY"
          ? [...container.querySelectorAll("details")]
              .find((node) => node.dataset.memoryRevision === focusedRevision)
              ?.querySelector("summary")
          : [...container.querySelectorAll("button")].find((node) =>
              Object.entries(focusedAction).every(([key, value]) => node.dataset[key] === value),
            );
      replacement?.focus({ preventScroll: true });
    }
    notebook.scrollTop = scrollTop;
  }
  function renderPresence() {
    const working = state.draft === "working";
    const quiet = state.initiative === "quiet" || state.withdrawn;
    $("#presence-state").textContent = working ? "草案を作成中" : "";
    $("#presence-footnote").innerHTML =
      state.draft === "ready" && state.initiative === "quiet" && !state.withdrawn
        ? '<button type="button" class="text-button" data-action="view-artifact" data-kind="journey">草案があります</button>'
        : "";
    window.yoriCharacter?.setState(working ? "working" : quiet ? "idle" : "listening");
  }
  function scrollToLatest() {
    unreadReply = false;
    newReplyButton.hidden = true;
    flow.scrollTop = flow.scrollHeight;
    const currentState = state;
    requestAnimationFrame(() => {
      if (currentState === state && !unreadReply) flow.scrollTop = flow.scrollHeight;
    });
  }
  function render({ follow = false, forceFollow = false } = {}) {
    const nearBottom = flow.scrollHeight - flow.scrollTop - flow.clientHeight < 100;
    const scrollTop = flow.scrollTop;
    renderMessages();
    renderNotebook();
    renderPresence();
    $("#sample-replies").innerHTML = replies()
      .map(
        (text) =>
          `<button type="button" class="reply-chip" data-action="sample" data-text="${escapeHTML(text)}">${escapeHTML(text)}</button>`,
      )
      .join("");
    if (forceFollow || (follow && nearBottom)) scrollToLatest();
    else {
      flow.scrollTop = scrollTop;
      if (follow) unreadReply = true;
    }
    newReplyButton.hidden = !unreadReply;
    $("#send-message").disabled = !input.value.trim();
  }
  function setNotebook(open, restoreFocus = false) {
    const nearBottom = flow.scrollHeight - flow.scrollTop - flow.clientHeight < 100;
    notebook.hidden = !open;
    $("[data-action=notebook]").setAttribute("aria-expanded", String(open));
    if (open) {
      renderNotebook();
      $("[data-action=close-notebook]").focus({ preventScroll: true });
    } else if (restoreFocus) $("[data-action=notebook]").focus({ preventScroll: true });
    if (nearBottom) scrollToLatest();
  }
  function openDialog(title, content) {
    dialogOpener = document.activeElement;
    $("#dialog-content").innerHTML =
      `<button type="button" class="dialog-close" data-action="close-dialog" aria-label="閉じる">${closeIcon}</button><h2 id="dialog-title">${escapeHTML(title)}</h2>${content}`;
    if (!dialog.open) dialog.showModal();
  }
  function closeDialog() {
    dialog.close();
  }
  function showArtifact(kind) {
    if (kind === "journey") {
      openDialog(
        "起動から翌日まで",
        '<ol><li><strong>起動</strong><br>前の会話をもとに、よりから提案する。</li><li><strong>確認</strong><br>調べた内容と、提案の理由を見る。</li><li><strong>訂正</strong><br>返事を受けて、記憶と草案を直す。</li><li><strong>翌日</strong><br>訂正した内容から、次の提案を考える。</li></ol><p class="draft-note">架空の草案です。</p>',
      );
    } else {
      state.openedArtifact = true;
      openDialog(
        "使い始めの3つの変更",
        '<div class="artifact-preview"><p><strong>A · 入口の説明</strong><br>何ができるか伝わりにくい。</p><p><strong>B · 設定項目</strong><br>どれを選べば始まるか分からない。</p><p><strong>C · 作業開始のボタン</strong><br>依頼する前に手順を考える必要がある。</p></div><p>使い始めの流れとして、まとめて見直したい。</p><p class="draft-note">A〜C は架空の資料です。</p>',
      );
      save();
    }
  }
  function sourceDialog(entry) {
    if (!entry) return;
    openDialog(
      entry.title,
      `<p>${escapeHTML(entry.certainty)} · ${escapeHTML(dayLabel(entry.day))}</p><blockquote><p>「${escapeHTML(entry.source)}」</p></blockquote><h3>いま覚えていること</h3><p>${escapeHTML(entry.value)}</p>${entry.sourceId ? '<p class="draft-note">このページで送った言葉をもとに更新しました。</p>' : '<p class="draft-note">体験の背景として用意した、架空の会話です。</p>'}`,
    );
  }
  function respond(text) {
    const sent = message("user", text);
    const selectedCorrection =
      correctionId && state.memories.find((entry) => entry.id === correctionId);
    correctionId = null;
    if (selectedCorrection && text.startsWith(`${selectedCorrection.title}について：`)) {
      const value = text.slice(`${selectedCorrection.title}について：`.length).trim();
      if (value) {
        recordMemory(
          selectedCorrection.id,
          selectedCorrection.title,
          value,
          text,
          sent.id,
          "あなたからの訂正",
        );
        if (["preference", "interpretation"].includes(selectedCorrection.id)) {
          cancelDraft();
          state.direction = "custom";
          state.concern = value;
        } else if (selectedCorrection.id === "initiative") {
          if (quietPreference(value)) state.initiative = "quiet";
          else if (normalPreference(value)) state.initiative = "normal";
        } else if (
          selectedCorrection.id === "scope" &&
          /読むだけ|見るだけ|草案.*(作らない|つくらない|やめて)/.test(value)
        ) {
          cancelDraft();
          state.withdrawn = true;
        }
        message("assistant", "覚えていた内容を直したよ。");
        journal(
          "覚えていたことを訂正した",
          `「${selectedCorrection.title}」について訂正を受けた。新しい言葉を残し、前の理解をそのまま使わないようにした。`,
          sent.id,
        );
        return;
      }
    }
    if (/今は話すだけ|話すだけに|やめて|見送|やっぱり違|今はいい|勝手に進めない/.test(text)) {
      cancelDraft();
      state.withdrawn = true;
      recordMemory(
        "withdrawal",
        "この取り組みについて",
        "いまの案はいったん見送る。本人から話が戻るまでは、同じ案を勧めない。",
        text,
        sent.id,
      );
      message("assistant", "うん、この案はいったん置いておくね。");
      journal(
        "いったん置いておく",
        "今は話すだけにしたいと聞いた。草案づくりを取り下げた。この話題は、こちらから繰り返し勧めない。",
        sent.id,
      );
    } else if (quietPreference(text)) {
      state.initiative = "quiet";
      recordMemory(
        "initiative",
        "声をかけるタイミング",
        "提案は控えめに。続きを見たいときに、本人から開けるようにする。",
        text,
        sent.id,
      );
      message("assistant", "わかった。草案はできたら置いておくね。");
      journal(
        "提案を控える",
        "提案は少なめがいいと聞いた。作業は続け、完了時の通知を控える。",
        sent.id,
      );
    } else if (normalPreference(text)) {
      state.initiative = "normal";
      recordMemory(
        "initiative",
        "声をかけるタイミング",
        "役に立ちそうな気づきや結果があれば、よりから伝えてよい。",
        text,
        sent.id,
      );
      message(
        "assistant",
        state.withdrawn
          ? "わかった。また、役に立ちそうなことがあれば話しかけるね。前に見送った案は、そのまま置いておくよ。"
          : "わかった。また、役に立ちそうな気づきや結果があれば話しかけるね。",
        state.draft === "ready" && !state.withdrawn ? "journey" : null,
      );
      journal(
        "声をかけるタイミングを見直す",
        "また提案してよいと聞いた。見送った取り組みの判断は保ったまま、意味のある変化を知らせるようにする。",
        sent.id,
      );
    } else if (/体験から|体験全体|根本|目的ベース|依頼.*なく|一つの体験/.test(text)) {
      const wasGrouping = state.direction === "grouping";
      cancelDraft();
      state.direction = "experience";
      state.withdrawn = false;
      state.draft = "none";
      state.concern = "依頼を決める前に、よりから会話が始まり、やりとりが次の行動につながること。";
      recordMemory(
        "preference",
        "大切にしていること",
        "変更をまとめる前に、使う人の体験を最初から一つの流れとして考えてほしい。",
        text,
        sent.id,
      );
      recordMemory(
        "interpretation",
        "次に考えたいこと",
        state.concern,
        text,
        sent.id,
        "会話を受けて見直した仮説",
      );
      message(
        "assistant",
        wasGrouping
          ? "PRの整理に寄りすぎてたね。起動したところから考え直してみる。"
          : "起動したところから、体験を考えてみるね。",
      );
      journal(
        "まとめ方より、体験から",
        wasGrouping
          ? "PRの整理を求められていると捉えていた。体験から考え直してほしいと訂正された。"
          : "体験から考えてほしいと聞いた。起動からの流れを草案にする。",
        sent.id,
      );
      beginDraft();
    } else if (/こういう方向|その方向.*いい|いいね|それがいい/.test(text)) {
      if (state.draft === "ready" && !state.withdrawn) {
        state.feedback = true;
        recordMemory(
          "feedback",
          "今回、合っていたこと",
          "一つの体験として示した草案は、進めたい方向に合っていた。",
          text,
          sent.id,
          "草案を見たあとの反応",
        );
        message("assistant", "うん、次も体験から考えるね。");
        journal("草案への反応", "この方向でよいと聞いた。次も体験から考える。", sent.id);
      } else {
        message(
          "assistant",
          "そう感じたところ、この会話に残しておくね。どのあたりがよかったかも、話したくなったら聞かせて。",
        );
        recordMemory(
          "feedback",
          "会話で伝えてくれたこと",
          text,
          text,
          sent.id,
          "まだ対象を確かめたい反応",
        );
      }
    } else if (/理由.*覚え|背景.*覚え/.test(text)) {
      const reason = "細かな変更の後始末を自分でする状態を減らし、全体を安心して任せたい。";
      if (state.scene === "first" && state.direction === "unknown") {
        message(
          "assistant",
          "うん。何が大切かだけでなく、そう思うようになったことも、一緒に聞いていきたい。",
        );
      } else {
        recordMemory("background", "その背景", reason, text, sent.id, "これまでの会話からの理解");
        message("assistant", "任せた後のつなぎ直しが、自分の仕事に戻ってくる。それが困るんだね。");
        journal(
          "好みの後ろにある理由",
          "好みだけでなく、後始末が自分に戻ってくる背景も覚えてほしいと聞いた。次の提案では、本人の手間が本当に減るかも考える。",
          sent.id,
        );
      }
    } else if (/草案の続き/.test(text) && state.direction === "experience" && !state.withdrawn) {
      message("assistant", "途中だった草案を続けるね。");
      beginDraft();
    } else if (/まず見せて|見せて|一緒に見/.test(text) && state.scene !== "first") {
      message(
        "assistant",
        state.direction === "experience"
          ? "いまの草案を、一緒に見てみよう。"
          : "入口の説明、設定、作業開始。この3つを並べてみたよ。\n別々の変更に見えるけれど、使い始めに迷うところは重なっていた。",
        state.draft === "ready" ? "journey" : "grouping",
      );
    } else if (/覚えている|覚えてる|記憶|日記/.test(text)) {
      message(
        "assistant",
        state.memories.length ? "いまの理解を開いたよ。違っていたら教えて。" : "まだ記録はないよ。",
      );
      setNotebook(true);
    } else if (/細かな改善|細かなPR|全体が見え/.test(text)) {
      recordMemory("preference", "気になっていること", text, text, sent.id);
      state.concern = "変更が増えても、全体がよくなった感じにつながらないこと。";
      message(
        "assistant",
        "一つずつは進んでいても、全体としてよくなった感じがしないんだね。\nどこがつながっていないのか、一緒に見ていきたい。",
      );
      journal(
        "はじめて聞いた困り事",
        "細かな改善が増えても全体が見えない、と聞いた。まず本人の言葉で記録した。原因や解決策は、まだ決めつけない。",
        sent.id,
      );
    } else if (/今日は別|話しながら知/.test(text)) {
      message("assistant", "今日は何が気になってる？");
    } else {
      recordMemory("note", "伝えてくれた言葉", text, text, sent.id, "この体験で受け取った言葉");
      message("assistant", "メモに残したよ。", null, {
        note: "用意したシナリオ以外の返答はできません。",
      });
      journal(
        "言葉をそのまま残す",
        "まだ解釈を決めず、伝えてくれた言葉を残した。次に話すときに、そこから確かめたい。",
        sent.id,
      );
    }
  }
  function submit(text) {
    const value = String(text).trim().slice(0, 2000);
    if (!value || composing) return;
    respond(value);
    input.value = "";
    state.inputDraft = "";
    render({ forceFollow: true });
    save();
    window.yoriCharacter?.acknowledge();
  }
  function nextDay() {
    cancelDraft();
    state.day++;
    if (state.withdrawn) {
      message(
        "assistant",
        "おかえり。前の案はいったん置いてあるよ。\n今日は、どんな話をしようか。",
      );
      journal(
        "見送ったことも、覚えている",
        "前の日に見送った案は、こちらから出し直さなかった。話したことを引き継いで、今日の会話を待つ。",
      );
    } else if (state.initiative === "quiet") {
      message("assistant", "おかえり。", "quiet-note");
      journal(
        "静かに過ごす選び方",
        "提案は少なめがいい、という話を引き継いだ。新しい案を送り続けず、見たいときに前の続きへ戻れるようにする。",
      );
    } else if (state.direction === "experience") {
      message(
        "assistant",
        state.draft === "ready"
          ? "おかえり。前に話した「体験から考えてほしい」をもとに、今日は実際に触れる形で確かめたい。草案を一緒に見る？"
          : "おかえり。前に話した体験の草案はまだ途中。続きから一緒に見ない？",
        state.draft === "ready" ? "journey" : null,
      );
      journal(
        "前の訂正が、今日の着眼点になる",
        "PRのまとめ方から始めず、使い始めの体験から考えた。前に聞いたことが、今日どこを見るかを変えている。",
      );
    } else if (state.direction === "custom") {
      message("assistant", `おかえり。前に話した「${state.concern}」の続きを考えたい。`);
      journal(
        "訂正した理解を引き継ぐ",
        "本人が書き直してくれた言葉を読み返した。前の理解で話を進めず、訂正後の内容を確かめる。",
      );
    } else if (state.scene === "first") {
      const received = state.memories.find(
        (entry) => entry.id === "note" || entry.id === "preference",
      );
      message(
        "assistant",
        received
          ? `また会えたね。前に話してくれた「${received.value}」が、少し頭に残ってる。\n今日は、その続きでも、別の話でも。`
          : "また会えたね。今日は、どんなことが頭に残ってる？",
      );
    } else {
      message(
        "assistant",
        "おかえり。前に並べた変更は、そのまま残してあるよ。\nまとめることが役に立ちそうか、もう少し話してみたい。",
        null,
        { origin: true },
      );
    }
    render({ forceFollow: true });
    save();
    toast("翌日に進めました");
  }
  function reset(scene) {
    cancelDraft();
    createScene(scene);
    input.value = "";
    correctionId = null;
    if (dialog.open) closeDialog();
    setNotebook(false);
    render();
    flow.scrollTop = 0;
    save();
    input.focus({ preventScroll: true });
  }
  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    switch (button.dataset.action) {
      case "sample":
        submit(button.dataset.text);
        break;
      case "latest":
        scrollToLatest();
        break;
      case "notebook":
        setNotebook(notebook.hidden);
        break;
      case "close-notebook":
        setNotebook(false, true);
        break;
      case "close-dialog":
        closeDialog();
        break;
      case "view-artifact":
        showArtifact(button.dataset.kind);
        break;
      case "origin":
        sourceDialog({
          title: "この提案のきっかけ",
          certainty: "前の会話（サンプル）",
          day: 0,
          source:
            "細かなPRが増えて、全体が見えないんだよね。任せたはずなのに、最後は自分でつなぎ直している感じがする。",
          value: "この話を受けて、よりは3つの変更を見比べ、同じ使い始めの迷いに気づいた。",
          sourceId: null,
        });
        break;
      case "message-source": {
        const source = state.messages.find((item) => item.id === button.dataset.message);
        if (source)
          openDialog(
            "このときの会話",
            `<p>${escapeHTML(dayLabel(source.day))} · ${source.role === "user" ? "あなた" : "より"}</p><p style="white-space:pre-wrap">${escapeHTML(source.text)}</p>`,
          );
        else toast("この会話は表示件数の上限より前です。振り返りの記録は残っています。");
        break;
      }
      case "correct-memory": {
        const entry = state.memories.find((item) => item.id === button.dataset.memory);
        if (!entry) break;
        correctionId = entry.id;
        input.value = `${entry.title}について：`;
        state.inputDraft = input.value;
        setNotebook(false);
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        $("#send-message").disabled = false;
        save();
        break;
      }
      case "next-day":
        nextDay();
        break;
      case "scene":
        reset(button.dataset.scene);
        break;
      case "scenes":
        openDialog(
          "体験を切り替える",
          '<p>現在のデモの会話をリセットします。</p><button type="button" class="scene-choice" data-action="scene" data-scene="return"><strong>前の会話から提案</strong></button><button type="button" class="scene-choice" data-action="scene" data-scene="first"><strong>はじめて会う</strong></button><button type="button" class="scene-choice" data-action="scene" data-scene="quiet"><strong>提案を控える</strong></button>',
        );
        break;
      case "about":
        openDialog(
          "このプロトタイプについて",
          '<p>返答は定型文、会話の背景と作業は架空です。AIには接続していません。</p><p>会話と記憶はこのブラウザ内に保存します。</p><p>返事を選び、「翌日を試す」で提案の変化を見られます。</p><p><a href="https://introducing.muse.ai/" target="_blank" rel="noopener noreferrer">参考：Meta Muse</a> · <a href="../omakase/index.html" target="_blank" rel="noopener noreferrer">前のデモ</a></p>',
        );
        break;
    }
  });
  $("#conversation-form").addEventListener("submit", (event) => {
    event.preventDefault();
    submit(input.value);
  });
  flow.addEventListener("scroll", () => {
    if (unreadReply && flow.scrollHeight - flow.scrollTop - flow.clientHeight < 100) {
      unreadReply = false;
      newReplyButton.hidden = true;
    }
  });
  input.addEventListener("input", () => {
    state.inputDraft = input.value;
    $("#send-message").disabled = !input.value.trim();
    save();
  });
  input.addEventListener("compositionstart", () => {
    composing = true;
  });
  input.addEventListener("compositionend", () => {
    composing = false;
  });
  input.addEventListener("keydown", (event) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.isComposing &&
      !composing &&
      event.keyCode !== 229
    ) {
      event.preventDefault();
      submit(input.value);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !dialog.open && !notebook.hidden) {
      event.preventDefault();
      setNotebook(false, true);
    }
  });
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    if (
      event.clientX < box.left ||
      event.clientX > box.right ||
      event.clientY < box.top ||
      event.clientY > box.bottom
    )
      closeDialog();
  });
  dialog.addEventListener("close", () => {
    if (dialogOpener?.isConnected) dialogOpener.focus({ preventScroll: true });
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
      remaining = Math.max(1, remaining - (Date.now() - timerStartedAt));
    } else if (document.visibilityState !== "hidden") scheduleDraft();
  });
  window.addEventListener("pagehide", () => {
    save();
    cancelDraft();
  });
  window.addEventListener("yorishiro:character-ready", (event) => {
    const ok = event.detail?.ok === true;
    document.body.classList.toggle("character-ready", ok);
    document.body.classList.toggle("character-error", !ok);
    if (!ok) $("#character-load").textContent = event.detail?.message || "画像表示で続けられます";
    renderPresence();
  });
  load();
  input.value = state.inputDraft;
  render();
  save();
})();
