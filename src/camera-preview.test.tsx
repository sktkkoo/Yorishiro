// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CameraPreview } from "./camera-preview";

beforeEach(() => {
  vi.setSystemTime(1000);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("local camera preview", () => {
  it.each([
    ["ja", "共有準備完了", "撮影済み・準備中", "AI送信済み"],
    ["en", "Ready to share", "Captured · preparing", "Sent to AI"],
  ])("distinguishes a staged image from an image sent to the agent in %s", (language, ready, pending, sent) => {
    const p = {
      sourceKind: "screen" as const,
      imageDataUrl: "data:image/jpeg;base64,YQ==",
      lastCapturedAt: 1000,
      lastSharedAt: 1000,
      language,
      onStop: vi.fn(),
    };
    const view = render(<CameraPreview {...p} deliveryMode="on-demand" />);
    expect(screen.getByText(ready)).toBeTruthy();
    expect(screen.queryByText(sent)).toBeNull();
    view.rerender(<CameraPreview {...p} deliveryMode="on-demand" lastCapturedAt={2000} />);
    expect(screen.getByText(pending)).toBeTruthy();
    view.rerender(<CameraPreview {...p} />);
    expect(screen.getByText(sent)).toBeTruthy();
  });

  it("offers explicit detach and attach controls without acquiring a second camera", () => {
    const onStop = vi.fn();
    const onDetach = vi.fn();
    const onAttach = vi.fn();
    const view = render(
      <CameraPreview
        stream={{} as MediaStream}
        onStop={onStop}
        onDetach={onDetach}
        language="ja"
      />,
    );
    expect(screen.getByText("停止")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "別ウィンドウで開く" }));
    expect(onDetach).toHaveBeenCalledOnce();
    expect(onStop).not.toHaveBeenCalled();
    view.rerender(
      <CameraPreview
        detached
        imageDataUrl="data:image/jpeg;base64,YQ=="
        onStop={onStop}
        onAttach={onAttach}
        language="ja"
      />,
    );
    expect(view.container.querySelector("video")).toBeNull();
    expect(screen.getByRole("img").getAttribute("src")).toBe("data:image/jpeg;base64,YQ==");
    fireEvent.click(screen.getByRole("button", { name: "ヨリシロ内に戻す" }));
    expect(onAttach).toHaveBeenCalledOnce();
  });

  it("uses the existing stream and leaves capture ownership intact when unmounted", () => {
    const stop = vi.fn();
    const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
    const onStop = vi.fn();
    const view = render(<CameraPreview stream={stream} onStop={onStop} language="ja" />);
    const video = screen.getByLabelText("共有中のカメラ映像") as HTMLVideoElement;
    expect(video.srcObject).toBe(stream);
    expect(video.muted).toBe(true);
    expect(video.playsInline).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "カメラ共有を停止" }));
    expect(onStop).toHaveBeenCalledOnce();
    view.unmount();
    expect(video.srcObject).toBeNull();
    expect(stop).not.toHaveBeenCalled();
  });

  it("restarts the flash only for a new capture", () => {
    const props = { stream: {} as MediaStream, onStop: vi.fn(), language: "ja" };
    const view = render(<CameraPreview {...props} />);
    expect(view.container.querySelector(".camera-preview-flash")).toBeNull();
    view.rerender(<CameraPreview {...props} lastCapturedAt={1000} />);
    const shutter = view.container.querySelector(".camera-preview-flash");
    expect(shutter).toBeTruthy();
    view.rerender(<CameraPreview {...props} lastCapturedAt={1000} lastSharedAt={1000} />);
    expect(view.container.querySelector(".camera-preview-flash")).toBe(shutter);
    view.rerender(<CameraPreview {...props} lastCapturedAt={2000} lastSharedAt={1000} />);
    expect(view.container.querySelector(".camera-preview-flash")).not.toBe(shutter);
  });
  it("does not replay an old capture when a preview is reopened", () => {
    vi.setSystemTime(10000);
    const view = render(
      <CameraPreview
        imageDataUrl="data:image/jpeg;base64,YQ=="
        lastCapturedAt={1000}
        onStop={vi.fn()}
      />,
    );
    expect(view.container.querySelector(".camera-preview-flash")).toBeNull();
  });
});
