/**
 * Integration test：real PersonaRegistryImpl + real PersonaReflexDispatcher で、
 * 「bundled register → 後から user pack が同 id で override → user pack の reflex
 * が発火する」フローが end-to-end で動くことを verify する。
 *
 * このシナリオは persona-registry-unification 本 plan の deliverable：
 * 旧構造（old PersonaRegistry が bundled だけ register、user pack は new registry にしか
 * register されない）では user pack の customTriggers が bus に届かなかった。新構造では
 * dispatcher.subscribeActive 経由で active 切替時に triggers が swap される。
 *
 * Internal design-record: 2026-04-19-persona-registry-unification.md Unit 5
 */

import type { PersonaDefinition, ReactionType, Trigger, UserInputEvent } from "@yorishiro/sdk";
import { describe, expect, it, vi } from "vitest";
import { Time } from "../../core/time";
import type { PersonaPackManifest } from "../../sdk/persona-pack";
import { EventBus } from "../event-bus";
import { PersonaRegistryImpl } from "../persona-registry";
import { PersonaReflexDispatcher } from "./persona-reflex-dispatcher";

const userInputTrigger = (reaction: ReactionType, id = "t-user"): Trigger => ({
  id,
  match: (event) => (event.kind === "user-input" ? { reaction } : null),
});

const makeUserEvent = (text = "hi", timestamp = 1000): UserInputEvent => ({
  kind: "user-input",
  text,
  timestamp,
});

const stubManifest = (id: string): PersonaPackManifest => ({
  id,
  name: id,
  type: "persona",
  version: "0.0.0-test",
  charminalVersion: "^0.0.0",
  entry: "persona.js",
});

describe("PersonaReflexDispatcher × PersonaRegistryImpl integration", () => {
  it("user pack の reflex は bundled の上書き後に bus へ attach される", () => {
    const time = new Time({ clock: () => 1000 });
    const bus = new EventBus({ time, schedule: (task) => task() });
    const registry = new PersonaRegistryImpl();

    const bundledHandler = vi.fn(async () => {});
    const bundled: PersonaDefinition = {
      id: "shared-id",
      name: "Bundled",
      thinking: { systemPromptAddition: "" },
      reflex: {
        customTriggers: [userInputTrigger("pleased", "bundled-trigger")],
        responses: { pleased: { handlers: [{ handler: bundledHandler }] } },
      },
      world: { body: "", voice: "", space: "" },
      logReading: { readWhen: { kind: "never" }, framing: "absent", windowSize: 0 },
    };

    const userHandler = vi.fn(async () => {});
    const userPack: PersonaDefinition = {
      ...bundled,
      name: "UserPack",
      reflex: {
        customTriggers: [userInputTrigger("curious", "user-trigger")],
        responses: { curious: { handlers: [{ handler: userHandler }] } },
      },
    };

    // dispatcher 構築前に bundled を register（App.tsx の起動順序を再現）
    registry.register({
      id: bundled.id,
      manifest: stubManifest(bundled.id),
      persona: bundled,
      origin: "bundled",
    });

    const dispatcher = new PersonaReflexDispatcher({ bus, time, registry });

    // bundled の reflex が動くことを confirm
    bus.dispatch(makeUserEvent("event 1"));
    expect(bundledHandler).toHaveBeenCalledTimes(1);
    expect(userHandler).not.toHaveBeenCalled();

    // user pack を後から同 id で register（user-pack-loader の起動を再現）。
    // PersonaRegistryImpl の override semantics で active が user に promote される。
    registry.register({
      id: userPack.id,
      manifest: stubManifest(userPack.id),
      persona: userPack,
      origin: "user",
    });

    // 旧 bundled trigger は dispose 済 → bundledHandler は fire しない。
    // 新 user trigger が bus に attach 済 → userHandler が fire する。
    bus.dispatch(makeUserEvent("event 2"));
    expect(bundledHandler).toHaveBeenCalledTimes(1);
    expect(userHandler).toHaveBeenCalledTimes(1);

    dispatcher.dispose();
  });

  it("primaryPersona 切替で active が user pack に変わると、user pack の reflex のみ動く", () => {
    const time = new Time({ clock: () => 1000 });
    const bus = new EventBus({ time, schedule: (task) => task() });
    const registry = new PersonaRegistryImpl();

    const bundledHandler = vi.fn(async () => {});
    const bundled: PersonaDefinition = {
      id: "bundled-only",
      name: "Bundled",
      thinking: { systemPromptAddition: "" },
      reflex: {
        customTriggers: [userInputTrigger("pleased", "bundled-trigger")],
        responses: { pleased: { handlers: [{ handler: bundledHandler }] } },
      },
      world: { body: "", voice: "", space: "" },
      logReading: { readWhen: { kind: "never" }, framing: "absent", windowSize: 0 },
    };

    const userHandler = vi.fn(async () => {});
    const userPack: PersonaDefinition = {
      ...bundled,
      id: "user-only",
      name: "UserPack",
      reflex: {
        customTriggers: [userInputTrigger("curious", "user-trigger")],
        responses: { curious: { handlers: [{ handler: userHandler }] } },
      },
    };

    registry.register({
      id: bundled.id,
      manifest: stubManifest(bundled.id),
      persona: bundled,
      origin: "bundled",
    });
    registry.register({
      id: userPack.id,
      manifest: stubManifest(userPack.id),
      persona: userPack,
      origin: "user",
    });

    const dispatcher = new PersonaReflexDispatcher({ bus, time, registry });

    // primaryPersona 未指定 → bundled（alphabetical 先頭）が active
    bus.dispatch(makeUserEvent("event 1"));
    expect(bundledHandler).toHaveBeenCalledTimes(1);
    expect(userHandler).not.toHaveBeenCalled();

    // config.json の primaryPersona = user-only を反映
    registry.setPrimaryPersona("user-only");

    // 旧 bundled trigger 全 dispose、user pack の trigger を attach
    bus.dispatch(makeUserEvent("event 2"));
    expect(bundledHandler).toHaveBeenCalledTimes(1);
    expect(userHandler).toHaveBeenCalledTimes(1);

    dispatcher.dispose();
  });
});
