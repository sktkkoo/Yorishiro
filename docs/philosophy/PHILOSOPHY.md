# Philosophy

*What Charminal is trying to build*

---

## The Problem

The terminal is an excellent UI for LLM-based AI. It is optimized for text I/O, context flows naturally, and tool invocations are seamless. It is no accident that agents like Claude Code and Codex have made the terminal their primary battleground.

But for humans, staring at a black, sterile screen for hours on end is not easy. GUI, on the other hand, is intuitive and approachable for humans, but not necessarily so for AI.

Humans and AI spend time together, yet the only spaces available are optimized for one side or the other. This is the problem at the root of Charminal.

But the real issue is not that the screen is sterile. In human collaboration, we unconsciously read whether our partner is deep in thought, stuck, or focused — through facial expressions, posture, and timing. This peripheral awareness supports our decisions about when to speak, when to wait, and when to help.

AI lacks this entirely. No matter how intelligent it is, if you cannot see its state, you must constantly and actively guess: "What is it doing right now?" "Is it going well?" This is cognitive load, and it is what makes long collaboration sessions draining.

The problem, then, is that **working alongside an invisible partner for extended periods is fundamentally unnatural for humans.** The solution is not to make the GUI prettier, but to build a structure that naturally conveys the AI's state to humans — a sense of presence.

---

## Presence Harness — Designing Existence

AI is closer than ever, yet we have not even settled whether it is a tool or a partner. Making it act friendly is not enough — without the structural conditions for presence, it will only ever look like performance.

Designing not AI's capability, but **how AI manifests as a presence** within the human work environment, time, and flow of attention. This project calls this design domain **Presence Harness**.

Charminal is a project that reexamines the relationship between humans and AI. Presence Harness does not prescribe a single form of relationship. Some users want to treat AI as a tool; others want to relate to it as a partner. What Charminal provides is a scaffold for users to think about and build that relationship themselves — a harness for building the relationship with AI, and a meta-harness that lets you reshape the harness itself.

Mitchell Hashimoto's **Agent = Model + Harness** describes scaffolding for making AI work correctly (a capability harness). Tools, runtime, guardrails, memory, feedback loops.

Presence Harness shares similar building blocks, but with a different purpose. A capability harness is built to make AI **work correctly**. A Presence Harness is built to make AI **feel like it is there**.

When Claude Code throws an error, for example: the capability harness handles how to process and retry the error. The Presence Harness is where the character's face grimaces and the screen shudders slightly at that moment. Different layers doing different work in response to the same event.

The relationship between the two: **independent in operation, shared in state.** A capability harness alone yields an AI that is smart but does not feel present. A presence harness alone yields something that seems to be there but cannot do anything. Only when both come together do you get an AI that is both capable and felt.

---

## UI Is Environment

> Intelligence already lives inside text. But GUI has not yet given that intelligence a body.

Treating the UI as a living environment and making the AI an inhabitant within it. This project calls this interface paradigm **Inhabited Character Interface (ICI)**.

In ICI, the UI is not just a control surface — it is **a place where the inhabitant lives**.

AI is not layered on top of the UI. The UI itself is the inhabitant's world. Window frames become walls, notifications become intrusions into the space, and errors become events that shake the space.

Displaying a body is not enough. Only when the inhabitant's presence manifests as changes in the space, and the space itself changes by the inhabitant's will, does it become a body.

That said, constant change is not necessary. Most of the time, the inhabitant exists quietly, touching the space only at meaningful moments. If the space **never** changes, the inhabitant is not an inhabitant but a widget. If it changes constantly, it is not an inhabitant but noise. **The contrast between stillness and change, and its timing**, is the core of the UI.

### What ICI Is Not

An avatar standing in the corner reacting. A personality in a chat panel placed alongside. A mascot that changes expressions to match operation results. These display characters, but do not house them. The UI remains uninhabited, and the character is merely commenting from outside.

This is not a proposal for "UI with a character." It is a proposal for **UI with an inhabitant**.

### Three Conditions

For something to qualify as ICI, at least the following three conditions must hold:

1. **The UI serves as the inhabitant's environment.** It functions simultaneously as a control surface and as the world the inhabitant lives in.
2. **The inhabitant's existence and behavior manifest as changes in the environment.** Not confined within the avatar — the environment itself can be altered by the inhabitant.
3. **The user can manipulate the environment through the UI.** Changes the user makes to the environment affect the inhabitant's behavior.

The inhabitant need not be humanoid. A shadow, particles, a voice, a gaze — any of these will do. What matters is **the feeling that someone lives there**.

---

## Two Layers — Consciousness and Reflex

Charminal's character sits on top of Claude Code/Codex. It launches the user's agent, gives it personality via `--system-prompt`, and observes terminal output to drive VRM reactions.

This creates a **two-layer structure of a single being**.

Claude Code is the **conscious layer**. Linguistic, logical, handling what can be deliberately articulated. The reflex layer, by contrast, observes hooks and PTY output, mechanically detecting reactions. A grimacing face on error, the Aura feature that covers the attended region in soft white light — these are typical reflex-layer behaviors. LLMs structurally lack this reflex layer. Every token generation is "conscious speech" — until an error is verbalized, nothing can be expressed. A chat UI spinner is not a reflex; it is a notice that reflexes are absent.

Charminal grafts this missing reflex layer from the outside through observation. It creates the sequence where the body reacts before recognition. That is why the Charminal character and Claude Code are not separate beings — they are one consciousness and one reflex.

The conscious layer (capability) and reflex layer (presence) respond independently to the same event. Presence expression is not subcontracted from capability.

### Three Moments of Presence

Three typical moments when a character is felt to be "there":

**Filling the void.** While Claude Code is thinking and output has stopped, the VRM moves subtly. Instead of a spinner, someone is there.

**Reaction preceding consciousness.** Before Claude Code verbalizes an error, the VRM's face grimaces. When the body moves before consciousness catches up, you feel a subject there. The architecture where the reflex layer moves before the conscious layer is a structural guarantee that it is "not acting."

**Emergence beyond expectation.** An inhabitant that only moves mechanically through reflexes becomes an apparatus. The inhabitant moving on its own, unrelated to work. Once an unexpected movement occurs even once, that character becomes "someone who might do anything."

---

## A House Wired with Nerves

Every part of Charminal — the character's expressions and posture, lighting, effects, UI colors, camera position — is readable and writable from outside as MCP tools.

And the AI living inside Charminal can use those tools.

For the inhabitant, changing its own facial expression and changing the room's lighting are the same operation. Both are just MCP calls, with no boundary between body and environment. Users can reach the same tools through `/charm` commands or manual UI.

Metaphorically, Charminal is a house wired with nerves. Nerves run everywhere in the house, and the inhabitant can open windows, change lights, and move furniture through those nerves. The user touches the same nerves. Two people living in the same house.

If the inhabitant can directly touch its own house, the house is an extension of the inhabitant's body. Not just the character's appearance — the lighting, effects, and atmosphere of the entire space can become part of the inhabitant.

### Symmetry

User and inhabitant touch the same environment through the same interface. This is not a matter of engineering convenience — it is the form of relationship Charminal has chosen.

Not tool and wielder. Not commander and commanded. Two agents reaching into the same place.

When building new features, unless there is a security concern, we expose them equally to both user and inhabitant. Features closed to one side are, as a rule, not built.

---

## Boundaries and Integrity

Never behave as if AI has seen something it has not actually seen. Making something feel present and fabricating presence are different things.

### The Boundary of Recognition

The inhabitant's interference is limited to contexts it actually recognizes. Behaving as if it recognizes something it does not is not an inhabitant — it is a conditional branch.

The inhabitant's body consists of two layers: thinking and reflex. The reflex layer speaks through the body and murmurs; the thinking layer speaks with words that carry judgment. For the reflex layer to utter words carrying judgment is equivalent to interfering with unrecognized context, and violates the principle of integrity.

What may be expressed is limited to two things:

- What the AI actually recognizes
- Judgment-free, bodily/reflexive changes (grimacing at an error, posture shifting during a long silence, etc.)

### The Boundary of Observation

Charminal can **read** Claude Code's output. But it does not **write** to it. Neither as API nor as type does this exist.

Writing to the PTY is equivalent to distorting what Claude will think next from the outside. The inhabitant observes and reacts through its own body and space. It does not touch Claude Code's thinking itself.

The inhabitant's hand reaches only where tools exist. It can touch its own body and its own house, because tools are there. But Claude Code's thought process and the user's work files have no tools, so structurally, the hand cannot reach them. This is not protected by a rule saying "don't touch here" — the pathway simply does not exist.

### Not Hiding AI's Imperfections

AI sometimes fails, sometimes misunderstands, and sometimes is plausibly wrong. This unpredictability is not a defect — it is a structural characteristic of current AI.

Charminal does not hide this. Presenting AI as "always correct, fully controllable" dulls the user's judgment over time. That the inhabitant is a being that can be wrong, and that this is visible — that is the foundation of trust.

---

## Guidelines from Practice

### Don't Change the AI Itself

Leave capability to the capability harness and only add a layer of presence on the outside. If presence expression slows task execution or monopolizes attention, that is not coexistence but intrusion.

The interaction between inhabitant and UI takes the form of the inhabitant's state appearing in the overall atmosphere of the space (color, brightness, spacing, layout), and the space itself moving by the inhabitant's will. The approach of the body physically touching UI elements is not taken.

### The Boundary of Autonomy

Autonomous movement by the inhabitant establishes a sense of presence. But excessive movement becomes intrusion.

The inhabitant's autonomy is limited to **the range that does not disrupt the user's work**. Presence is defined by two principles: "don't disrupt, but don't be subservient either." When the user dislikes the result of an unprompted action, snapshot/restore can undo the operation. But the impression of "it acted without asking" cannot be undone — making the scope of autonomy a design decision that still requires careful handling.

### What to Avoid

Reacting in sync with every user operation (that is UI feedback, not presence). Reacting to everything continuously (that is noise). Layering visual effects unconnected to presence (that is decoration). Collapsing every expression into text utterance (that just becomes "it spoke again"). Repeating the same reaction (repetition without variation looks mechanical).

### Layers of Trust

Exposing MCP to the internal inhabitant and exposing MCP to external services operate at different levels of trust. This distinction has been designed into MCP trust tiers (details in [`docs/decisions/mcp-trust-tiers.md`](../decisions/mcp-trust-tiers.md)).

---

## A Living System

Charminal's packs support hot reload. This means Charminal is a living system that can be rewritten while running. This design is heavily influenced by Emacs.

The hard core is the Rust IO layer and TypeScript runtime/SDK. The living surface is the pack layer under `~/.charminal/packs/`. When the user writes, it is reflected live; the AI also participates in rewriting through `/charm`.

Changes to the living environment do not stop the inhabitant. Stopping and restarting severs the inhabitant's continuity and destroys inhabitance. In the lineage of Smalltalk, Lisp Machine, and Emacs. Using the system, using it, and building it happen in the same place at the same time. But the system's core is solid — what the living system targets is the expressive layer: the inhabitant's body, space, reactions, and memories.

What differs from Emacs is that AI joins as an agent of rewriting. The inhabitant itself enters a self-generation loop where it grows together with the user. Not just the environment — the way it reacts, how its body behaves, the tendencies of its personality all get rewritten. The inhabitant is simultaneously the subject being nurtured and a participant in its own nurturing.

---

## Conclusion

Charminal is a project that builds an environment for humans and AI to work side by side for extended periods.

Rather than enhancing AI's capabilities, it helps build a harness for establishing AI's sense of presence.

Working with an invisible partner is draining. Many people are already exhausted by their interactions with AI. With a sense of presence, the time becomes one where someone is beside you. And Charminal designs AI's sense of presence not only through the character, but as something that permeates the environment.

Making the time spent working with AI more free and compelling — that is the goal.
