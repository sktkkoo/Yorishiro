import { useCallback, useEffect, useRef, useState } from "react";
import { ScreenSharingAuxiliaryHost, type ScreenSharingAuxiliaryModel } from "./auxiliary-windows";

function withTheme(model: ScreenSharingAuxiliaryModel): ScreenSharingAuxiliaryModel {
  const style = getComputedStyle(document.documentElement);
  const names = [
    "bg",
    "fg",
    "fg-dim",
    "sidebar-bg",
    "panel-bg",
    "border",
    "button-bg",
    "button-fg",
    "input-bg",
    "accent",
    "accent-soft",
    "accent-border",
    "muted",
    "glow",
  ];
  return {
    ...model,
    uiColors: Object.fromEntries(
      names.map((name) => {
        const key = `--yorishiro-${name}`;
        return [key, style.getPropertyValue(key).trim()];
      }),
    ),
  };
}

export function useAuxiliaryScreenSharing(model: ScreenSharingAuxiliaryModel) {
  const host = useRef<ScreenSharingAuxiliaryHost | null>(null);
  const latest = useRef(model);
  latest.current = model;
  const [error, setError] = useState<string>();

  useEffect(() => {
    const bridge = new ScreenSharingAuxiliaryHost((failure) => setError(String(failure)));
    host.current = bridge;
    bridge.update(withTheme(latest.current));
    const observer = new MutationObserver(() => bridge.update(withTheme(latest.current)));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style", "class"],
    });
    return () => {
      observer.disconnect();
      if (host.current === bridge) host.current = null;
      bridge.dispose();
    };
  }, []);

  useEffect(() => {
    host.current?.update(withTheme(model));
  }, [model]);

  const open = useCallback(async () => {
    const bridge = host.current;
    setError(undefined);
    try {
      if (!bridge) throw new Error("Screen sharing controls are not ready.");
      await bridge.open();
      if (host.current !== bridge) throw new Error("Screen sharing controls changed. Try again.");
      setError(undefined);
    } catch (failure) {
      if (host.current === bridge) setError(String(failure));
      throw failure;
    }
  }, []);

  return { open, error };
}
