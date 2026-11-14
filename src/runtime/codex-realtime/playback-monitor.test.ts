// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { monitorPlayback } from "./playback-monitor";

function setup() {
  const context = Object.assign(new EventTarget(), {
    state: "running",
    resume: vi.fn(async () => {
      context.state = "running";
    }),
    close: vi.fn(),
  });
  const peer = {
    getStats: vi.fn(
      async () =>
        new Map([
          [
            "audio",
            {
              type: "inbound-rtp",
              kind: "audio",
              bytesReceived: 128,
              packetsReceived: 4,
              secret: "private",
            },
          ],
          ["video", { type: "inbound-rtp", kind: "video", bytesReceived: 10000 }],
        ]),
    ),
  };
  const stream = { getAudioTracks: () => [{ readyState: "live", muted: false }] };
  const onSample = vi.fn();
  const onFailure = vi.fn();
  const stop = monitorPlayback({
    context: context as unknown as AudioContext,
    peer: peer as unknown as RTCPeerConnection,
    stream: stream as unknown as MediaStream,
    gain: () => 0.3,
    hasSignal: () => true,
    onSample,
    onFailure,
  });
  return { context, peer, onSample, onFailure, stop };
}
afterEach(() => vi.useRealTimers());
describe("playback monitor", () => {
  it("resumes an interrupted output once and keeps each observer independently owned", async () => {
    const a = setup();
    const b = setup();
    a.context.state = "interrupted";
    a.context.dispatchEvent(new Event("statechange"));
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(a.context.resume).toHaveBeenCalledOnce());
    expect(b.context.resume).not.toHaveBeenCalled();
    expect(a.onFailure).not.toHaveBeenCalled();
    a.stop();
    a.context.state = "suspended";
    a.context.dispatchEvent(new Event("statechange"));
    b.context.state = "suspended";
    b.context.dispatchEvent(new Event("statechange"));
    await vi.waitFor(() => expect(b.context.resume).toHaveBeenCalledOnce());
    expect(a.context.resume).toHaveBeenCalledOnce();
    expect(a.context.close).not.toHaveBeenCalled();
    b.stop();
  });
  it("reports receipt separately from analyser/gain without persisting track IDs or raw stats", async () => {
    const value = setup();
    await vi.waitFor(() => expect(value.onSample).toHaveBeenCalledOnce());
    expect(value.onSample).toHaveBeenCalledWith({
      contextState: "running",
      gain: 0.3,
      analyserSignal: true,
      liveRemoteTracks: 1,
      mutedRemoteTracks: 0,
      inboundAudioBytes: 128,
      inboundAudioPackets: 4,
      statsAvailable: true,
    });
    expect(JSON.stringify(value.onSample.mock.calls)).not.toContain("private");
    value.stop();
  });
  it("surfaces output recovery failure rather than leaving an active silent input", async () => {
    const value = setup();
    value.context.resume.mockRejectedValueOnce(new Error("OS failure"));
    value.context.state = "suspended";
    value.context.dispatchEvent(new Event("statechange"));
    await vi.waitFor(() => expect(value.onFailure).toHaveBeenCalledOnce());
    expect(value.onFailure.mock.calls[0][0].message).toContain("Turn voice off and on");
    value.stop();
  });
  it("bounds a stalled output resume before reporting reconnect", async () => {
    vi.useFakeTimers();
    const value = setup();
    value.context.resume.mockImplementationOnce(() => new Promise<void>(() => {}));
    value.context.state = "interrupted";
    value.context.dispatchEvent(new Event("statechange"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(value.onFailure).toHaveBeenCalledOnce();
    value.stop();
  });
  it("ignores pending resume/stat completion after disposal and cancels sampling", async () => {
    vi.useFakeTimers();
    const value = setup();
    let finish: (() => void) | undefined;
    value.context.resume.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    value.context.state = "interrupted";
    value.context.dispatchEvent(new Event("statechange"));
    value.stop();
    finish?.();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(value.onSample).not.toHaveBeenCalled();
    expect(value.onFailure).not.toHaveBeenCalled();
    expect(value.peer.getStats).toHaveBeenCalledOnce();
  });
  it("closed output asks for reconnect and fresh monitor can run after the previous one stops", async () => {
    const first = setup();
    first.context.state = "closed";
    first.context.dispatchEvent(new Event("statechange"));
    expect(first.onFailure).toHaveBeenCalledOnce();
    first.stop();
    const next = setup();
    await vi.waitFor(() => expect(next.onSample).toHaveBeenCalledOnce());
    expect(next.onFailure).not.toHaveBeenCalled();
    next.stop();
  });
});
