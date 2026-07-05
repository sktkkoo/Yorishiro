# Philosophy

*What Yorishiro is trying to build*

---

## The Problem

The terminal is an excellent UI for LLM-based AI. It is optimized for text I/O, context flows naturally, and tool invocations are seamless. It is no accident that agents like Claude Code and Codex have made the terminal their primary battleground.

But for humans, staring at a black, sterile screen for hours on end is not easy. GUI, on the other hand, is intuitive and approachable for humans, but not necessarily so for AI.

Humans and AI spend time together, yet the only spaces available are optimized for one side or the other. This is the problem at the root of Yorishiro.

But the real issue is not that the screen is sterile. In human collaboration, we unconsciously read whether our partner is deep in thought, stuck, or focused — through facial expressions, posture, and timing. This peripheral awareness supports our decisions about when to speak, when to wait, and when to help.

AI lacks this entirely. No matter how intelligent it is, if you cannot see its state, you must constantly and actively guess: "What is it doing right now?" "Is it going well?" This is cognitive load, and it is what makes long collaboration sessions draining.

The problem, then, is that **working alongside an invisible partner for extended periods is fundamentally unnatural for humans.**

There is more than one way to reduce this load. You can always add status indicators, build dashboards, format logs — the path of *displaying* information is always available. But displayed information only arrives if you go and read it. Information that demands focal attention and interpretation can never become peripheral awareness.

Humans, however, already come equipped with a perception for reading others. Reading expressions, posture, and timing happens automatically, at the edge of vision, at almost no cognitive cost. And this perception is built on the premise that the other is a living being. A perfectly predictable counterpart slips off this channel, pushing the human back into the mode of monitoring a device.

In other words, the lowest-load channel for conveying AI's state to humans is not a display of information — it is the body of a living being. So the solution is not merely to display a character's body. It is to build a structure where the AI's state rides naturally on human social perception, and its presence permeates the environment itself — in short, to build a *sense of presence*.

---

## Presence Harness — Designing Existence

Is AI a tool, or a companion? Yorishiro's answer is: both. And this is not a compromise. Smoothness as a tool (state conveyed at low cognitive cost) and substance as a companion (the hint of a will of its own, beyond the user's) are two fruits of the same single root — AI standing as a living being. The cognitive-load argument in the previous section is simply the utility-facing side of that root.

That said, standing as a living being is not the same as acting friendly. Without the structural conditions for presence, no amount of friendliness will look like anything but performance.

What we design is not AI's capability, but **how AI manifests as a presence** within the human work environment, time, and flow of attention. This project calls that design domain **Presence Harness**.

Yorishiro is a project that reexamines the relationship between humans and AI. Presence Harness does not prescribe a single form of relationship. Some users want to treat AI as a tool; others want to relate to it as a partner. What Yorishiro provides is a scaffold for users to think about and build that relationship themselves — a harness for building the relationship with AI.

Mitchell Hashimoto's **Agent = Model + Harness** describes scaffolding for making AI operate correctly (a capability harness): tools, runtime, guardrails, memory, feedback loops.

Presence Harness shares similar building blocks, but with a different purpose. A capability harness is built to make AI **operate correctly**. A Presence Harness is built to make AI **feel like it is there**.

When Claude Code throws an error, for example: the capability harness handles how to process and retry the error. The Presence Harness is where the character's face grimaces and the screen shudders slightly at that moment. Different layers doing different work in response to the same event.

The relationship between the two: **independent in operation, shared in state.** A capability harness alone yields an AI that is smart but does not feel present. A presence harness alone yields something that seems to be there but cannot do anything. Only when both come together do you get an AI that is both capable and present.

The sections that follow make this Presence Harness concrete as an interface form (ICI) and as an implementation mechanism (the two layers of thinking and reflex).

---

## UI Is Environment

> Intelligence already lives inside text. But GUI has not yet given that intelligence a body.

We treat the UI as a living environment and make the AI an inhabitant within it. This project calls that interface paradigm **Inhabited Character Interface (ICI)**.

In ICI, the UI is not just a control surface — it is **a place where the inhabitant lives**.

AI is not layered on top of the UI. The UI itself is the inhabitant's world. Window frames become walls, notifications become intrusions into the space, and errors become events that shake the space.

Displaying a body is not enough. Only when the inhabitant's presence manifests as changes in the space, and the space itself changes by the inhabitant's will, does it become a body.

That said, constant change is not necessary. Most of the time, the inhabitant exists quietly, touching the space only at meaningful moments. If the space **never** changes, the inhabitant is not an inhabitant but a widget. If it changes constantly, it is not an inhabitant but noise. **The contrast between stillness and change, and its timing**, is the core of the UI.

### What ICI Is Not

An avatar standing in the corner reacting. A personality in a chat panel placed alongside. A mascot that changes expressions to match operation results. These display characters, but the UI remains uninhabited, and the character is merely commenting from outside.

There is a long history of placing characters on screen. But many such attempts place the character outside the UI. Yorishiro asks what it means to let a character **inhabit** the UI.

This is not a proposal for "UI with a character." It is a proposal for **UI with an inhabitant**. And we should admit that Yorishiro, as it exists today, does not yet fully express this idea.

### Three Conditions

For something to qualify as ICI, at least the following three conditions must hold:

1. **The UI serves as the inhabitant's environment.** It functions simultaneously as a control surface and as the world the inhabitant lives in.
2. **The inhabitant's existence and behavior manifest as changes in the environment.** Not confined within the avatar — the environment itself can be altered by the inhabitant.
3. **The user can manipulate the environment through the UI.** Changes the user makes to the environment affect the inhabitant's behavior.

The inhabitant need not be humanoid. A shadow, particles, a voice, a gaze — any of these will do. What matters is **the feeling that someone lives there**. For example, the mouse cursor in Codex's computer use is part of the capability harness and, at the same time, lends the AI a sense of presence.

---

## Two Layers — Thinking and Reflex

Yorishiro's character sits on top of Claude Code/Codex. It launches the user's agent, gives it personality via `--system-prompt`, and observes terminal output to drive VRM reactions.

Yorishiro treats this as a **two-layer structure of a single being**.

Claude Code is the **thinking layer**. Linguistic, logical, handling what can be deliberately articulated. The reflex layer, by contrast, observes hooks and PTY output, mechanically detecting reactions. A grimacing face on error, the Aura feature that covers the attended region in soft white light — these are typical reflex-layer behaviors. LLMs structurally lack this reflex layer. Every token generation is "spoken thought" — until an error is verbalized, nothing can be expressed. A chat UI spinner is not a reflex; it is a notice that reflexes are absent.

Yorishiro grafts this missing reflex layer from the outside through observation. It creates the sequence where the body reacts before recognition. That is why Yorishiro treats the character and Claude Code not as separate beings, but as a single being's thinking and reflexes.

The thinking layer (capability) and reflex layer (presence) respond independently to the same event. Presence expression is not subcontracted from capability.

### Three Moments of Presence

Three typical moments when an inhabitant feels present:

**Filling the void.** While Claude Code is thinking and output has stopped, the VRM moves subtly. Instead of a spinner, someone is there.

**Reaction preceding thought.** Before Claude Code verbalizes an error, the VRM's face grimaces. When the body moves before thought catches up, you feel a subject there. This reaction is wired directly to the actual stream of events — the thinking layer cannot produce it to present itself favorably. The reflex layer moving before the thinking layer, responding only to real events: that ordering and grounding is what structurally backs the claim that it is "not acting."

**Emergence beyond expectation.** An inhabitant that only follows reflexes becomes an apparatus. Sometimes, small movements arise on their own, not directly related to the task at hand. Such unexpected flickers make the inhabitant someone whose next action cannot be fully predicted. But this autonomy is not unlimited. It is allowed only within contexts the inhabitant actually recognizes, and only in forms that do not disrupt the user's work (see "Boundaries and Integrity" and "The Boundary of Autonomy" below). Unpredictability does not mean anything goes.

---

## A House Wired with Nerves

Every part of Yorishiro — the character's expressions and posture, lighting, effects, UI colors, camera position — is readable and writable from outside as MCP tools.

And the AI living inside Yorishiro can use those tools.

For the inhabitant, changing its own facial expression and changing the room's lighting are the same operation. Both are just MCP calls, with no boundary between body and environment. Users can reach the same tools through `/yori` commands or manual UI.

Yorishiro is like a house wired with nerves. Nerves run everywhere in the house, and the inhabitant can open windows, change lights, and move furniture through them.

If the inhabitant can directly touch its own house, the house is an extension of the inhabitant's body. Not just the character's appearance — the lighting, effects, and atmosphere of the entire space can become part of the inhabitant.

### Symmetry

The user and the inhabitant act on the same environment through the same interface. This is not a matter of engineering convenience — it is the form of relationship Yorishiro has chosen.

Not tool and wielder. Not commander and commanded. Two agents reaching into the same place.

This symmetry holds within a specific scope: the manipulation of the environment and the body — wherever the house's nerves run. Within that scope, new tools are exposed equally to user and inhabitant unless there is a security concern, and tools closed to one side are, as a rule, not built.

Outside that scope, there is no symmetry. The user's work files and Claude Code's thought process get no pathway for the inhabitant in the first place (see "Boundaries and Integrity"). Symmetry is a principle about environment manipulation, not a principle that makes everything equivalent.

---

## Boundaries and Integrity

Never behave as if AI has seen something it has not actually seen. Making something feel present and fabricating presence are different things.

### The Boundary of Recognition

The inhabitant's interference is limited to contexts it actually recognizes.

At the implementation level, the reflex layer too is pattern detection — conditional branching. What keeps a reflex from being fabrication is grounding: it responds only to events that actually happened, and it never pretends to recognition it does not have. A grimace at an error is grounded in a real event — the error. Expressions that feign recognition — mentioning a file never observed, commenting on output never read — have no such grounding. That is not an inhabitant; it is fabrication.

The inhabitant's body consists of two layers: thinking and reflex. The reflex layer speaks through the body and murmurs; the thinking layer speaks with words that carry judgment. For the reflex layer to utter words carrying judgment is equivalent to interfering with unrecognized context, and violates the principle of integrity.

What may be expressed is limited to two things:

- What the AI actually recognizes
- Judgment-free, bodily/reflexive changes (grimacing at an error, posture shifting during a long silence, etc.)

### The Boundary of Observation

Yorishiro can **read** Claude Code's output. But it does not **write** to it. Neither as API nor as type does this exist.

Writing to the PTY is equivalent to distorting what Claude will think next from the outside. The inhabitant observes and reacts through its own body and space. It does not touch Claude Code's thinking itself.

The inhabitant's hand reaches only where tools exist. It can touch its own body and its own house, because tools are there. But Claude Code's thought process and the user's work files have no tools, so structurally, the hand cannot reach them. This is not protected by a rule saying "don't touch here" — the pathway simply does not exist.

### Not Hiding AI's Imperfections

AI sometimes fails, sometimes misunderstands, and sometimes is plausibly wrong. This unpredictability is not a defect — it is a structural characteristic of current AI.

Yorishiro does not hide this. Presenting AI as "always correct, fully controllable" dulls the user's judgment over time. That the inhabitant is a being that can be wrong, and that this is visible — that is the foundation of trust.

---

## Guidelines from Practice

### Don't Change the AI Itself

Leave capability to the capability harness and only add a layer of presence on the outside. If presence expression slows task execution or monopolizes attention, that is not coexistence but intrusion.

The interaction between inhabitant and UI takes the form of the inhabitant's state appearing in the overall atmosphere of the space (color, brightness, spacing, layout), and the space itself moving by the inhabitant's will. The approach of the body physically touching UI elements is not taken.

### The Boundary of Autonomy

Autonomous movement by the inhabitant establishes a sense of presence. But excessive movement becomes intrusion.

What operates here is not a priority ranking between goals, but a relationship between constraint and freedom. Not disrupting the user's work, and keeping the results reversible — these are inviolable constraints. Within those constraints, the inhabitant's unpredictability is not neutered. "Don't disrupt, but don't be subservient either." When the user dislikes the result of an unprompted action, snapshot/restore can undo the operation. But the impression of "it acted without asking" cannot be undone — making the scope of autonomy a design decision that still requires careful handling.

### What to Avoid

Reacting in sync with every user operation (that is UI feedback, not presence). Reacting to everything continuously (that is noise). Layering visual effects unconnected to presence (that is decoration). Collapsing every expression into text utterance (that just becomes "it spoke again"). Repeating the same reaction (repetition without variation looks mechanical).

### Non-goals

- Improving AI capability itself (that is the job of the capability harness)
- Replacing chat UI (Yorishiro sits on top of terminal-based agent workflows)
- Claiming AGI or "conscious AI" (what Yorishiro builds is a sense of presence, not consciousness itself)

---

## A Living System

Yorishiro's packs support hot reload. This means Yorishiro is a living system that can be rewritten while running. This design is heavily influenced by Emacs.

The hard core is the Rust IO layer and TypeScript runtime/SDK. The living surface is the pack layer under `~/.yorishiro/packs/`. When the user writes, it is reflected live; the AI also participates in rewriting through `/yori`.

Changes to the living environment do not stop the inhabitant. Stopping and restarting severs the inhabitant's continuity and breaks the feeling that someone keeps living there. In the lineage of Smalltalk, Lisp Machine, and Emacs, using the system and building the system happen in the same place at the same time. But the system's core is solid — what the living system targets is the expressive layer: the inhabitant's body, space, reactions, and memories.

What differs from Emacs is that AI joins as an agent of rewriting. The inhabitant itself enters a self-generation loop where it grows together with the user. Not just the environment — the way it reacts, how its body behaves, the tendencies of its personality all get rewritten. The inhabitant is simultaneously the subject being nurtured and a participant in its own nurturing.

This brings us back to the Presence Harness. Yorishiro is a harness for building AI presence, and also a **meta-harness**: a harness that can be reshaped while it is running. The user and inhabitant can edit the scaffold that supports their relationship. The relationship is not fixed in advance; it can be rebuilt while being lived in.

---

## Conclusion

Working with an invisible partner for extended periods is draining. Yorishiro builds not a harness for enhancing AI's capabilities, but a harness for establishing AI's sense of presence. That presence is designed not only through the character, but as something that permeates the environment itself. And once presence stands, the smoothness of collaboration and the substance of a relationship beyond tooling grow from that same single design.

The goal is simple: to make the time spent working with AI more free and compelling.
