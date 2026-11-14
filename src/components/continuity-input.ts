interface TextDraft {
  readonly text: string;
}
export interface ContinuityInput {
  readonly normal: TextDraft;
  readonly corrections: ReadonlyMap<string, TextDraft>;
  readonly target: { readonly id: string | null };
}
const emptyInput = (): ContinuityInput => ({
  normal: { text: "" },
  corrections: new Map(),
  target: { id: null },
});

export function readContinuityInput(serialized: string | null): ContinuityInput {
  try {
    const value = JSON.parse(serialized ?? "null");
    if (!value || typeof value !== "object" || Array.isArray(value)) return emptyInput();
    if (value.version === 1) {
      if (
        typeof value.normal !== "string" ||
        !value.corrections ||
        typeof value.corrections !== "object" ||
        Array.isArray(value.corrections) ||
        !(value.correctionId === null || typeof value.correctionId === "string")
      )
        return emptyInput();
      const entries = Object.entries(value.corrections);
      if (entries.some(([id, text]) => !id || typeof text !== "string")) return emptyInput();
      const corrections = new Map(entries.map(([id, text]) => [id, { text: text as string }]));
      if (value.correctionId !== null && !corrections.has(value.correctionId)) return emptyInput();
      return { normal: { text: value.normal }, corrections, target: { id: value.correctionId } };
    }
    // 旧形式の訂正文は通常返信へ混ぜず、その対象だけへ引き継ぐ。
    if (
      value.version === undefined &&
      typeof value.text === "string" &&
      (value.correctionId === null || typeof value.correctionId === "string")
    ) {
      const input = emptyInput();
      return value.correctionId
        ? {
            ...input,
            corrections: new Map([[value.correctionId, { text: value.text }]]),
            target: { id: value.correctionId },
          }
        : { ...input, normal: { text: value.text } };
    }
  } catch {
    // 壊れた下書きデータはネイティブの会話記録へ影響させない。
  }
  return emptyInput();
}

export function serializeContinuityInput(input: ContinuityInput): string {
  return JSON.stringify({
    version: 1,
    normal: input.normal.text,
    corrections: Object.fromEntries([...input.corrections].map(([id, draft]) => [id, draft.text])),
    correctionId: input.target.id,
  });
}

export function activeContinuityInput(input: ContinuityInput): TextDraft {
  return input.target.id === null
    ? input.normal
    : (input.corrections.get(input.target.id) ?? { text: "" });
}

export function selectCorrection(
  input: ContinuityInput,
  id: string,
  value: string,
): ContinuityInput {
  const corrections = new Map(input.corrections);
  if (!corrections.has(id)) corrections.set(id, { text: value });
  return { ...input, corrections, target: { id } };
}

export function cancelCorrection(input: ContinuityInput): ContinuityInput {
  return { ...input, target: { id: null } };
}

export function editContinuityInput(input: ContinuityInput, text: string): ContinuityInput {
  if (input.target.id === null) return { ...input, normal: { text } };
  return { ...input, corrections: new Map(input.corrections).set(input.target.id, { text }) };
}

export function forgetCorrection(input: ContinuityInput, id: string): ContinuityInput {
  if (!input.corrections.has(id)) return input;
  const corrections = new Map(input.corrections);
  corrections.delete(id);
  return { ...input, corrections, target: input.target.id === id ? { id: null } : input.target };
}

export function finishContinuityInput(
  input: ContinuityInput,
  submitted: ContinuityInput,
): ContinuityInput {
  const id = submitted.target.id;
  const current = id === null ? input.normal : input.corrections.get(id);
  if (current !== activeContinuityInput(submitted)) return input;
  // 送信後に選び直した対象や新しい入力には、古い完了通知で触れない。
  if (input.target.id === id && input.target !== submitted.target) return input;
  return id === null ? { ...input, normal: { text: "" } } : forgetCorrection(input, id);
}
