import { useEffect, useRef } from "react";

interface Props {
  readonly frameCount: number;
  readonly disabled?: boolean;
  readonly language: string;
  readonly onChange: (frameCount: number) => void;
}

export function MotionSharingToggle({ frameCount, disabled, language, onChange }: Props) {
  const previousFrameCount = useRef(16);
  useEffect(() => {
    if (frameCount > 1) previousFrameCount.current = frameCount;
  }, [frameCount]);
  const label = language.startsWith("ja")
    ? "コマ送りで動きを伝える"
    : "Show motion with sequential frames";
  const enabled = frameCount > 1;
  return (
    <label className="screen-sharing-pointer-toggle">
      <span className="screen-sharing-label">{label}</span>
      <input
        type="checkbox"
        role="switch"
        aria-label={label}
        aria-checked={enabled}
        checked={enabled}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked ? previousFrameCount.current : 1)}
      />
    </label>
  );
}
