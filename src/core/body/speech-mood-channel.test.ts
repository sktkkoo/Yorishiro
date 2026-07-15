import { describe, expect, it, vi } from "vitest";
import { SpeechMoodChannel, type SpeechMoodHandle } from "./speech-mood-channel";

function createHarness() {
  const handles: Array<SpeechMoodHandle> = [];
  const acquire = vi.fn((_preset: string, _intensity: number): SpeechMoodHandle => {
    const handle = {
      setIntensity: vi.fn(),
      release: vi.fn(),
    };
    handles.push(handle);
    return handle;
  });
  return { channel: new SpeechMoodChannel(acquire), acquire, handles };
}

describe("SpeechMoodChannel", () => {
  it("attack 時間で 0 から指定 intensity まで ramp する", () => {
    const { channel, acquire, handles } = createHarness();
    channel.setSpeechMood("happy", 0.8);

    expect(acquire).toHaveBeenCalledWith("happy", 0);
    channel.update(0.15);
    expect(handles[0]?.setIntensity).toHaveBeenLastCalledWith(0.4);

    channel.update(0.15);
    expect(handles[0]?.setIntensity).toHaveBeenLastCalledWith(0.8);
  });

  it("release 時間で 0 まで ramp してから handle を解放する", () => {
    const { channel, handles } = createHarness();
    channel.setSpeechMood("sad", 0.8);
    channel.update(0.3);

    channel.releaseSpeechMood();
    channel.update(0.25);
    expect(handles[0]?.setIntensity).toHaveBeenLastCalledWith(0.4);
    expect(handles[0]?.release).not.toHaveBeenCalled();

    channel.update(0.25);
    expect(handles[0]?.setIntensity).toHaveBeenLastCalledWith(0);
    expect(handles[0]?.release).toHaveBeenCalledOnce();
  });

  it("新しい mood は前の handle を即時解放して上書きする", () => {
    const { channel, acquire, handles } = createHarness();
    channel.setSpeechMood("happy", 0.8);
    channel.update(0.1);

    channel.setSpeechMood("surprised", 0.6);

    expect(handles[0]?.release).toHaveBeenCalledOnce();
    expect(acquire).toHaveBeenLastCalledWith("surprised", 0);
    channel.update(0.15);
    expect(handles[1]?.setIntensity).toHaveBeenLastCalledWith(0.3);
  });

  it("intensity を 0-1 にクランプする", () => {
    const { channel, handles } = createHarness();
    channel.setSpeechMood("angry", 3);
    channel.update(0.3);
    expect(handles[0]?.setIntensity).toHaveBeenLastCalledWith(1);
  });
});
