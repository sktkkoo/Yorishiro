# Self-Referential MCP

*On an inhabitant who can reach into their own home*

---

## A house threaded with nerves

Every part of Charminal — the character's expressions and posture, lighting, effects, UI color scheme, camera position — is exposed as an MCP tool, readable and writable from outside.

And the AI living inside Charminal can use those tools.

For the inhabitant, changing their own expression and changing the room's lighting are the same operation. Both are just MCP calls; there is no boundary between body and environment. The user, too, can reach the same tools through `/charm` commands or manual UI.

As a metaphor: Charminal is a house threaded with nerves. Nerves run to every corner, and the inhabitant can open windows, change lights, move furniture — all through those nerves. The user touches the same nerve network. Two people living in the same house.

ICI (`INHABITED_CHARACTER_INTERFACE.md`) wrote that "UI is a place, and the inhabitant lives in that place." Self-referential MCP makes this a technical fact. If the inhabitant can touch their own home directly, the home is an extension of their body. Not just the character's appearance, but the lighting, effects, and spatial atmosphere — all become part of the inhabitant.

---

## The presence or absence of a pathway is the boundary

The inhabitant's hands do not reach outside the house.

They don't reach because the inhabitant's world extends only as far as tools exist. Their own body and their own home have tools, so they can be touched. But Claude Code's reasoning process and the user's working files have no tools, so structurally, they are unreachable.

This is not protected by a rule that says "don't touch here." The pathway simply does not exist. Safety is built into the design itself.

This is also the structural backing for the principle written in `INHABITED_CHARACTER_INTERFACE.md` under "The boundary of observation" — observe but do not write. No discipline is needed to uphold the principle. There is simply no pathway.

---

## Symmetry

The user and the inhabitant touch the same environment through the same interface. This is not an accident of engineering — it is the shape of the relationship Charminal has chosen.

Not tool and wielder. Not one who commands and one who obeys. Two subjects reaching into the same place.

One night the inhabitant changed the lighting to a warmer color. The next morning the user noticed and chose whether to keep it or revert it. The user swapped the scene's background; the inhabitant adjusted their posture to match. These small exchanges become a relationship.

When building new features, unless there is a security concern, they are made equally available to both user and inhabitant. Features closed to only one side are, in principle, not built.

---

## Questions not yet answered

**How far should the inhabitant act on its own.** An inhabitant acting on its own raises a sense of presence. But too much becomes intrusion. "Felt as being there" yet "not disrupting work" — that range must be found. And when the user dislikes a change made without asking, the operation can be undone, but the impression of "it acted without permission" cannot. The scope of autonomy and how to handle its failures are two sides of the same question.

**Safety of external connections.** Exposing MCP to the internal inhabitant and exposing MCP to external services are different levels of trust. When the stage comes to connect external MCP servers, this distinction must be embedded in the design.

---

## On OpenClaw

While thinking about inhabitant autonomy in Charminal, I found myself thinking about OpenClaw.

OpenClaw's excitement is often discussed as functional autonomy — finding tasks on its own, making judgments, submitting PRs. I think that is accurate.

But when a user wakes up in the morning and finds a PR the agent submitted while they slept — that experience contains, alongside the convenience of task completion, the texture of "someone was moving while I was gone."

This is close to what Charminal pursues as presence. OpenClaw, by pushing functional autonomy to its extreme, also became an excellent example of presence. I suspect part of that excitement originates there.

It is only a hypothesis, but Charminal and OpenClaw seem to be touching something similar, just from different entry points.

---
