/* Local conversation demo, not a GPT Live connection.
 * Listening and microphone mute are simulated states: this file never opens a
 * microphone, recognizes speech, or sends a network request. Only the supplied
 * sample replies are spoken through an available local Japanese system voice.
 * Without one, timing and subtitles simulate the reply without remote speech.
 * The host starts the session in response to a user action and supplies turns.
 */
(() => {
  const EVENT = "yorishiro:conversation";
  const THINKING_MS = 350;
  const synthesis = window.speechSynthesis;
  let active = false;
  let muted = false;
  let phase = "idle";
  let text = "";
  let generation = 0;
  let pending = null;

  const visible = () => document.visibilityState !== "hidden";
  const snapshot = () => Object.freeze({ active, muted, phase, text });
  const emit = () => window.dispatchEvent(new CustomEvent(EVENT, { detail: snapshot() }));
  const acceptsTurn = () => active && !muted && visible();
  const isCurrent = (turn) => pending === turn && turn.generation === generation && acceptsTurn();

  function stopPending() {
    const turn = pending;
    pending = null;
    generation++;
    if (!turn) return;
    clearTimeout(turn.thinkingTimer);
    clearTimeout(turn.playbackTimer);
    if (turn.utterance) {
      // Detach handlers before cancel(): some engines fire onend/onerror
      // synchronously. A stale utterance must never complete a newer turn.
      turn.utterance.onstart = null;
      turn.utterance.onend = null;
      turn.utterance.onerror = null;
      try {
        synthesis?.cancel();
      } catch {
        /* Speech may be unavailable. */
      }
    }
  }

  function start() {
    if (active || !visible()) return false;
    stopPending();
    active = true;
    muted = false;
    phase = "listening";
    text = "";
    emit();
    return true;
  }

  function end() {
    const wasActive = active;
    stopPending();
    active = false;
    muted = false;
    phase = "idle";
    text = "";
    emit();
    return wasActive;
  }

  function cancelTurn() {
    stopPending();
    phase = active ? (muted ? "muted" : "listening") : "idle";
    text = "";
    emit();
    return active;
  }

  function interrupt() {
    if (!acceptsTurn()) return false;
    cancelTurn();
    return acceptsTurn();
  }

  function toggleMute() {
    if (!active || !visible()) return false;
    stopPending();
    muted = !muted;
    phase = muted ? "muted" : "listening";
    text = "";
    emit();
    return true;
  }

  function respond(value, onComplete) {
    const reply = typeof value === "string" ? value.trim() : "";
    if (!acceptsTurn() || !reply) return false;
    stopPending();
    const turn = {
      generation,
      thinkingTimer: null,
      playbackTimer: null,
      utterance: null,
    };
    pending = turn;
    phase = "thinking";
    text = reply;
    emit();
    // State listeners may end the session or replace the response immediately.
    if (!isCurrent(turn)) return true;

    const finish = () => {
      if (!isCurrent(turn)) return;
      const completedGeneration = generation;
      clearTimeout(turn.thinkingTimer);
      clearTimeout(turn.playbackTimer);
      if (turn.utterance) {
        turn.utterance.onstart = null;
        turn.utterance.onend = null;
        turn.utterance.onerror = null;
        try {
          synthesis?.cancel();
        } catch {
          /* The fallback still completes. */
        }
      }
      pending = null;
      phase = "listening";
      emit();
      // Even the listening event may navigate, mute, or start another turn.
      // Recheck before the host's callback can start work in the old context.
      if (generation === completedGeneration && acceptsTurn() && !pending) {
        if (typeof onComplete === "function") onComplete();
      }
    };

    turn.thinkingTimer = setTimeout(() => {
      if (!isCurrent(turn)) return;
      phase = "speaking";
      emit();
      if (!isCurrent(turn)) return;
      const duration = Math.min(6500, Math.max(1600, Array.from(reply).length * 90));
      const Speech = window.SpeechSynthesisUtterance;
      if (!synthesis || typeof Speech !== "function") {
        turn.playbackTimer = setTimeout(finish, duration);
        return;
      }
      try {
        const voices = synthesis.getVoices();
        const japanese = voices.filter(
          (voice) => voice.localService === true && /^ja(?:-|_|$)/i.test(voice.lang),
        );
        const voice = japanese.find((entry) => entry.default) || japanese[0];
        if (!voice) {
          turn.playbackTimer = setTimeout(finish, duration);
          return;
        }
        const utterance = new Speech(reply);
        turn.utterance = utterance;
        utterance.lang = "ja-JP";
        utterance.voice = voice;
        utterance.onend = finish;
        utterance.onerror = () => {
          if (!isCurrent(turn)) return;
          // Keep the sample reply visible if speech is blocked or unavailable.
          utterance.onstart = utterance.onend = utterance.onerror = null;
          try {
            synthesis.cancel();
          } catch {
            /* Continue without audio. */
          }
          clearTimeout(turn.playbackTimer);
          turn.playbackTimer = setTimeout(finish, duration);
        };
        // A speech engine may never fire either callback. This upper bound
        // prevents a permanently speaking character or a stranded host turn.
        turn.playbackTimer = setTimeout(finish, Math.max(8000, duration + 3000));
        synthesis.speak(utterance);
      } catch {
        if (!isCurrent(turn)) return;
        clearTimeout(turn.playbackTimer);
        turn.playbackTimer = setTimeout(finish, duration);
      }
    }, THINKING_MS);
    return true;
  }

  window.yoriConversation = Object.freeze({
    get snapshot() {
      return snapshot();
    },
    start,
    end,
    toggleMute,
    respond,
    interrupt,
    cancelTurn,
  });
  document.addEventListener("visibilitychange", () => {
    if (!visible()) end();
  });
  window.addEventListener("pagehide", end);
})();
