import type { UiPackDefinition } from "@yorishiro/sdk";

/** 会話の表示と入力は host が所有し、住人の描画域とカメラは通常表示を保つ。 */
const chat: UiPackDefinition = {
  id: "chat",
  type: "ui",
  layout: { presence: { target: "shell" } },
  mount() {
    return { dispose() {} };
  },
};

export default chat;
