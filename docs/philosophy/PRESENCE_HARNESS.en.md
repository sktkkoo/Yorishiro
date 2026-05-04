# Presence Harness

*Designing how AI exists*

---

## What this is

AI already shares your workspace. Agents like Claude Code persist in your terminal, linger beside your editor. AI occupies part of your working hours.

And yet, despite AI being this close, we still do not know how to regard it. A tool that answers when called? A counterpart you work with? How should a UI express this presence?

No matter how intelligent, if it is merely a response machine, it is hard to feel that you share a space with it. No matter how friendly its manner, if the conditions of existence are not in place, it looks like mere performance.

Not what AI can do, but **how it appears as a presence** within someone's work, time, and attention — designing that is Presence Harness.

---

## Contrast with the capability harness

Mitchell Hashimoto's **Agent = Model + Harness** describes scaffolding that makes AI work correctly (a capability harness). Tools, execution environments, guardrails, memory, feedback loops.

Presence Harness has similar components but a different purpose. The capability harness is assembled to make AI **work correctly**. Presence Harness is assembled so that AI **feels like it is there**.

For example, when Claude Code encounters an error: the capability harness handles how to process and retry that error. Presence Harness handles the character's face grimacing at that moment, the temperature of the space shifting slightly. The same event, different layers doing different work.

The relationship: **operation is independent, state is shared.** The capability harness does not alter its behavior for the presence harness, nor does the presence harness intervene in the capability harness's decisions. With only the capability harness, AI is smart but does not feel like it is there. With only the presence harness, it feels like it is there but cannot do anything. Only with both does AI become something that is both capable and felt as present.

---

## The boundary of recognition

AI must not behave as though it sees what it has not actually seen.

Making something feel present and fabricating presence are different things. If AI pretends to see what it has not seen, pretends to understand what it does not understand, that is not Presence — it is performance.

What may be expressed is limited to two things:

- What the AI has actually recognized
- Bodily, reflexive changes that carry no judgment (grimacing at an error, posture shifting during long silence, etc.)

This boundary becomes the foundation of long-term trust.

---

## Principles that emerged from practice

**Do not alter the AI itself.** Leave capability to the capability harness; merely add a layer of existence on the outside.

**Do not obstruct function.** If expressions of existence slow down task execution or continually seize attention, that is not coexistence but intrusion.

**Do not repeat the same reaction.** Even for the same state, introduce variation in expression. But variation only in expression — not occasionally pretending to see unseen things, but varying how you react to what is seen.

**Run function and existence independently.** For the same event, the function side and the existence side each respond. Expressions of existence are not subcontractors of function.

Conversely, what to avoid: synchronously reacting to every user operation (becomes UI feedback, not presence). Reacting to everything continuously (becomes noise). Layering visual effects unconnected to existence (becomes decoration). Every expression being absorbed into text utterance (becomes "it just talked again").

---

## Forms of expression

Presence Harness is not limited to a single form of expression.

- **Inhabited Character Interface (ICI)** — Treating the UI as a living environment and making AI exist as an inhabitant. Charminal takes this approach. → `INHABITED_CHARACTER_INTERFACE.en.md`
- **Ambient Presence** — Expressing existence as light or atmosphere without foregrounding a body
- **Tactile Presence** — Conveying existence through vibration, pressure, and rhythms of touch without occupying vision

---

## Document relationships

```
Presence Harness ← this document
  └─ Forms of expression
      ├─ ICI        → INHABITED_CHARACTER_INTERFACE.en.md
      │   └─ Charminal → CHARMINAL.en.md
      ├─ Ambient Presence
      └─ Tactile Presence
```
