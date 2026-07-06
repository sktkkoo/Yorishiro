// @vitest-environment jsdom

import { useFrame } from "@react-three/fiber";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttentionLightCueStore } from "../attention-light-cue";
import { ATTENTION_CUE_DURATION_SECONDS } from "./attention-cue-envelope";
import {
  AttentionCueLight,
  DefaultAttentionCueLight,
  useClaimAttentionCue,
} from "./attention-cue-light";
import { AttentionLightSettingsStore } from "./attention-light-settings";

vi.mock("@react-three/fiber", () => ({
  useFrame: vi.fn(),
}));

// three-runtime.ts は r3f-host.tsx 経由で @react-three/fiber の extend() を
// module 読み込み時に呼ぶため、上の useFrame-only mock のままでは実 module を
// import できない。attention-cue-light.tsx は barrel 経由で import しているので
// ここも barrel 側（"../three-runtime"）を mock する（r3f-runtime-root.test.tsx の前例）。
// DefaultAttentionCueLight は getAnchor を注入できない（本物の singleton を使う
// 契約のため）ので、claim test 群はこのモック既定値（VRM ロード済み想定の
// head 位置）で描画されることを前提にする。anchor null のケースは
// AttentionCueLight 側で getAnchor prop を明示注入して個別に検証済み。
vi.mock("../three-runtime", () => ({
  getThreeRuntime: () => ({
    getCharacterAnchor: () => ({ x: 0, y: 1.35, z: 0 }),
  }),
}));

const GROUP_SELECTOR = "[name='yorishiro-attention-cue-light']";

function makeCueStore(): AttentionLightCueStore {
  return new AttentionLightCueStore({ settings: new AttentionLightSettingsStore() });
}

function runLatestFrame(elapsedTime: number) {
  const calls = vi.mocked(useFrame).mock.calls;
  const frame = calls[calls.length - 1]?.[0] as unknown as
    | ((state: { clock: { elapsedTime: number } }) => void)
    | undefined;
  if (!frame) throw new Error("useFrame callback was not registered");
  act(() => {
    frame({ clock: { elapsedTime } });
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AttentionCueLight", () => {
  it("cue が無い間は useFrame callback を登録しない", () => {
    const cueStore = makeCueStore();
    const anchor = { x: 0, y: 1.35, z: 0 };
    render(<AttentionCueLight cueStore={cueStore} getAnchor={() => anchor} />);

    expect(useFrame).not.toHaveBeenCalled();
  });

  it("cue の発火で点灯し、duration 経過後に消灯する", () => {
    const cueStore = makeCueStore();
    const anchor = { x: 0, y: 1.35, z: 0 };
    const { container } = render(
      <AttentionCueLight cueStore={cueStore} getAnchor={() => anchor} />,
    );
    expect(container.querySelector(GROUP_SELECTOR)).toBeNull();

    act(() => {
      cueStore.cueForAttention("s1:100");
    });
    expect(container.querySelector(GROUP_SELECTOR)).not.toBeNull();

    runLatestFrame(10);
    expect(container.querySelector(GROUP_SELECTOR)).not.toBeNull();

    runLatestFrame(10 + ATTENTION_CUE_DURATION_SECONDS + 0.01);
    expect(container.querySelector(GROUP_SELECTOR)).toBeNull();
  });

  it("seq が変わるたび envelope を最初から再生する", () => {
    const cueStore = makeCueStore();
    const anchor = { x: 0, y: 1.35, z: 0 };
    const { container } = render(
      <AttentionCueLight cueStore={cueStore} getAnchor={() => anchor} />,
    );

    act(() => {
      cueStore.cueForAttention("s1:100");
    });
    runLatestFrame(10);
    runLatestFrame(10 + ATTENTION_CUE_DURATION_SECONDS + 0.01);
    expect(container.querySelector(GROUP_SELECTOR)).toBeNull();

    act(() => {
      cueStore.cueForAttention("s2:200");
    });
    expect(container.querySelector(GROUP_SELECTOR)).not.toBeNull();
  });

  it("position prop 指定時は getAnchor を呼ばない", () => {
    const cueStore = makeCueStore();
    const getAnchor = vi.fn(() => ({ x: 9, y: 9, z: 9 }));
    const { container } = render(
      <AttentionCueLight cueStore={cueStore} position={[1, 2, 3]} getAnchor={getAnchor} />,
    );

    act(() => {
      cueStore.cueForAttention("s1:100");
    });

    expect(container.querySelector(GROUP_SELECTOR)).not.toBeNull();
    expect(getAnchor).not.toHaveBeenCalled();
  });

  it("anchor が null かつ position 未指定なら描画しない", () => {
    const cueStore = makeCueStore();
    const { container } = render(<AttentionCueLight cueStore={cueStore} getAnchor={() => null} />);

    act(() => {
      cueStore.cueForAttention("s1:100");
    });

    expect(container.querySelector(GROUP_SELECTOR)).toBeNull();
  });

  it("run-slow-completed cue では scene 照明を描画しない", () => {
    const cueStore = makeCueStore();
    const anchor = { x: 0, y: 1.35, z: 0 };
    const { container } = render(
      <AttentionCueLight cueStore={cueStore} getAnchor={() => anchor} />,
    );

    act(() => {
      cueStore.cueForRun("run-slow-completed", "run:s1:1", "s1");
    });

    expect(container.querySelector(GROUP_SELECTOR)).toBeNull();
    expect(useFrame).not.toHaveBeenCalled();
  });
});

describe("AttentionCueLight claim（yielding default）", () => {
  it("scene が AttentionCueLight を mount している間 default は描画せず、unmount で復活する", () => {
    const cueStore = makeCueStore();
    const anchor = { x: 0, y: 1.35, z: 0 };

    const { container, rerender } = render(<DefaultAttentionCueLight cueStore={cueStore} />);

    act(() => {
      cueStore.cueForAttention("s1:100");
    });
    expect(container.querySelectorAll(GROUP_SELECTOR)).toHaveLength(1);

    rerender(
      <>
        <DefaultAttentionCueLight cueStore={cueStore} />
        <AttentionCueLight cueStore={cueStore} getAnchor={() => anchor} />
      </>,
    );
    // scene 側の 1 灯だけが残り、default は退いている(2 灯になっていない)。
    expect(container.querySelectorAll(GROUP_SELECTOR)).toHaveLength(1);

    rerender(<DefaultAttentionCueLight cueStore={cueStore} />);
    expect(container.querySelectorAll(GROUP_SELECTOR)).toHaveLength(1);
  });

  it("useClaimAttentionCue のみでも default は退く（描画なし）", () => {
    const cueStore = makeCueStore();

    function ClaimOnly() {
      useClaimAttentionCue();
      return null;
    }

    const { container, rerender } = render(<DefaultAttentionCueLight cueStore={cueStore} />);

    act(() => {
      cueStore.cueForAttention("s1:100");
    });
    expect(container.querySelectorAll(GROUP_SELECTOR)).toHaveLength(1);

    rerender(
      <>
        <DefaultAttentionCueLight cueStore={cueStore} />
        <ClaimOnly />
      </>,
    );
    expect(container.querySelectorAll(GROUP_SELECTOR)).toHaveLength(0);

    rerender(<DefaultAttentionCueLight cueStore={cueStore} />);
    expect(container.querySelectorAll(GROUP_SELECTOR)).toHaveLength(1);
  });
});
