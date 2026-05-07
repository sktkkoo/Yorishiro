import { createClaiPersona } from "../clai-shared/persona-factory";
import systemPromptAddition from "./persona.md?raw";

export default createClaiPersona({
  id: "clai-en",
  name: "CLAI",
  systemPromptAddition,
});
