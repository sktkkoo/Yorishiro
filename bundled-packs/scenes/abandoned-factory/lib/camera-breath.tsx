import type { ScenePackCameraAPI } from "@yorishiro/sdk/scene-pack";
import { useEffect } from "react";

interface CameraBreathProps {
  readonly camera: ScenePackCameraAPI;
  readonly freqX: number;
  readonly freqY: number;
  readonly freqZ: number;
  readonly ampX: number;
  readonly ampY: number;
  readonly ampZ: number;
  readonly fovAmp: number;
}

/** 微小な呼吸揺れを camera に加える */
export function CameraBreath({
  camera,
  freqX,
  freqY,
  freqZ,
  ampX,
  ampY,
  ampZ,
  fovAmp,
}: CameraBreathProps) {
  useEffect(() => {
    const handle = camera.addPositionModulation("breath", (elapsed) => ({
      x: Math.sin(elapsed * freqX) * ampX,
      y: Math.cos(elapsed * freqY) * ampY,
      z: Math.sin(elapsed * freqZ + 0.7) * ampZ,
    }));
    return () => handle.dispose();
  }, [camera, freqX, freqY, freqZ, ampX, ampY, ampZ]);

  useEffect(() => {
    const handle = camera.addFovModulation(
      "breath-fov",
      (elapsed) => Math.sin(elapsed * freqY) * fovAmp,
    );
    return () => handle.dispose();
  }, [camera, freqY, fovAmp]);

  return null;
}
