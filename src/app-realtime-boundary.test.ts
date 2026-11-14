import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// native 環境全体を起動せず、App の音声配線が過去の記録を運ばない境界を AST で検査する。
const source = ts.createSourceFile(
  "App.tsx",
  readFileSync(new URL("./App.tsx", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
function nodesMatching<T extends ts.Node>(guard: (node: ts.Node) => node is T): T[] {
  const matches: T[] = [];
  const visit = (node: ts.Node) => {
    if (guard(node)) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return matches;
}

describe("App realtime memory boundary", () => {
  it("has no retained-history reader or refresh subscription in its voice wiring", () => {
    const imports = nodesMatching(ts.isImportDeclaration).map((node) =>
      node.moduleSpecifier.getText(source),
    );
    expect(
      imports.some(
        (name) =>
          name.includes("voice-continuity") || name.includes("use-continuity-voice-context"),
      ),
    ).toBe(false);
    const calls = nodesMatching(ts.isCallExpression);
    expect(
      calls.some((call) =>
        [
          "readVoiceContinuityPrompt",
          "useContinuityVoiceContext",
          "prepareContinuityContext",
        ].includes(call.expression.getText(source)),
      ),
    ).toBe(false);
    const voice = calls.filter((call) => call.expression.getText(source) === "useCodexRealtime");
    expect(voice).toHaveLength(1);
    const options = voice[0].arguments[0];
    expect(ts.isObjectLiteralExpression(options)).toBe(true);
    if (!ts.isObjectLiteralExpression(options))
      throw new Error("Voice options must be inspectable");
    const properties = options.properties.filter(ts.isPropertyAssignment);
    const startup = properties.find(
      (property) => property.name.getText(source) === "includeStartupContext",
    );
    expect(startup?.initializer.kind).toBe(ts.SyntaxKind.FalseKeyword);
    const snapshot = properties.find(
      (property) => property.name.getText(source) === "getPersonaSnapshot",
    );
    expect(snapshot && ts.isArrowFunction(snapshot.initializer)).toBe(true);
    if (
      !snapshot ||
      !ts.isArrowFunction(snapshot.initializer) ||
      !ts.isBlock(snapshot.initializer.body)
    )
      throw new Error("Missing persona snapshot");
    const result = snapshot.initializer.body.statements.find(ts.isReturnStatement)?.expression;
    expect(result && ts.isObjectLiteralExpression(result)).toBe(true);
    if (!result || !ts.isObjectLiteralExpression(result))
      throw new Error("Missing snapshot result");
    expect(result.properties.map((property) => property.name?.getText(source)).sort()).toEqual([
      "instructions",
      "personaId",
    ]);
    // 実際の発話の永続化と persona 所有権の境界は残す。
    expect(
      properties.some((property) => property.name.getText(source) === "onConversationExchange"),
    ).toBe(true);
    expect(
      properties.some((property) => property.name.getText(source) === "conversationOwnerKey"),
    ).toBe(true);
  });
});
