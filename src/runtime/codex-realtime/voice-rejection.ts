/**
 * Codex app-server が `thread/realtime/start` を「voice が無効 / 未対応」として
 * 明確に拒否したエラーかどうかの判定。
 *
 * true のときに限り voice fallback（persona override → global → built-in default）
 * を試してよい。認証・接続・permission・timeout などの一般エラーを voice fallback
 * で隠さないため、message が voice 自体に言及し、かつ拒否語彙を含む場合だけ true
 * にする保守的な判定を採る。Codex 側の error message 形式は版により揺れるため、
 * 構造化 code ではなく部分一致で判定する（false negative は「fallback しないで
 * エラー表示」という安全側に倒れる）。
 */

/** lowercase 済み text 中の "voice(s)" への言及。`invoice` などの部分一致は除外する。 */
const VOICE_MENTION = /(^|[^a-z])voices?($|[^a-z])/;

const REJECTION_PHRASES = [
  "unsupported",
  "not supported",
  "does not support",
  "invalid",
  "unknown",
  "unavailable",
  "not available",
  "unrecognized",
  "not allowed",
  "no such",
] as const;

export function isCodexVoiceRejectionMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  if (!VOICE_MENTION.test(normalized)) return false;
  return REJECTION_PHRASES.some((phrase) => normalized.includes(phrase));
}
