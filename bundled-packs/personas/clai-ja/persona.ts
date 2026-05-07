import { createClaiPersona } from "../clai-shared/persona-factory";
import systemPromptAddition from "./persona.md?raw";

export default createClaiPersona({
  id: "clai-ja",
  name: "CLAI",
  systemPromptAddition,
});
