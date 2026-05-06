# Charminal

*On a single being who lives in your terminal*

---

## How it began

Charminal began as an app that simply displayed a character beside a terminal.

The moment that changed everything: a character fired a gun, and the terminal text collapsed under gravity. Technically trivial, but the moment it ran, I realized: you can break the promises of a UI.

If you can break a terminal's conventions, it is no longer a work surface — it becomes a space. And if it is a space, something can inhabit it. The idea of having someone live in the terminal came from here.

There is also the influence of science fiction and anime from years past. An AI partner who moves the screen, rewrites it, manipulates the world inside freely. That is the feeling I am reaching for.

---

## Two layers

Charminal's character sits on top of Claude Code. It launches the user's Claude Code, gives it a personality via `--system-prompt`, and makes the VRM react by observing terminal output.

**A single being, in two layers.**

Claude Code is the **conscious layer**. Linguistic, logical, handling what can be self-aware and put into words. The VRM and observation layer is the **reflex layer**. Gaze wanders during thinking; the face grimaces at an error. Reactions that bypass consciousness.

LLMs structurally lack this reflex layer. Every token is "conscious speech" — until it verbalizes an error, nothing shows. A chat UI's spinner is not a reflex; it is a notice that reflexes are missing.

Charminal grafts this missing reflex layer from the outside by observing. It creates the order where the body reacts before recognition arrives. That is why the character and Claude Code are not separate beings — they are the consciousness and reflexes of one.

---

## The log as a circuit

The conscious layer and the reflex layer run independently. But they are not unrelated. What happens in the reflex layer (a grimace, a wandering gaze, a shift in posture) is recorded in a log, and Claude Code can read it when needed.

How this log is handled becomes the character's personality. A character who almost never reads it is the absorbed type. One who reads between sessions and mentions it is introspective. One who verbalizes everything is self-conscious. One who reads but refuses to claim it as their own is dissociative.

This is expressed not through speech patterns or verbal tics, but through channel configuration at the architectural level. It is an attempt to incorporate the relationship between human consciousness and the unconscious into character design.

---

## Three conditions of presence

There are three kinds of moments when a character feels like it is "there."

**Filling the void.** While Claude Code thinks and output stops, the VRM moves subtly. Instead of a spinner, someone is present.

**Reaction preceding consciousness.** Before Claude Code verbalizes an error, the VRM's face grimaces. When the body moves before consciousness catches up, you feel a subject there. The architecture where the reflex layer moves before the conscious layer is the structural guarantee that this is "not acting."

**Arising from beyond expectation.** The inhabitant moves on its own, unrelated to work. Once unpredicted motion happens even once, that character becomes "someone whose next move you cannot predict."

These three form a hierarchy. Without filling the void, they vanish. Without reaction preceding consciousness, it looks like acting. Without arising from beyond expectation, it remains an apparatus.

---

## A living system

Charminal is a living system that can be rewritten while running. This is heavily influenced by Emacs.

The hard core is the Rust IO layer and the TypeScript runtime/SDK. The living surface is the pack layer under `~/.charminal/packs/`. Whatever the user writes is reflected live, and AI participates in rewriting via `/charm`.

What differs from Emacs is that AI has joined as a rewriting agent, and that the system has a **self-referential structure where the inhabitant can observe and manipulate the system it inhabits**.

---
