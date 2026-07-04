const RELOAD_SURFACE_COLOR = "#020304";

export function applyReloadDocumentBackground(): void {
  document.documentElement.style.backgroundColor = RELOAD_SURFACE_COLOR;
  if (document.body) {
    document.body.style.backgroundColor = RELOAD_SURFACE_COLOR;
  }
}

export async function setReloadNativeBackground(): Promise<void> {
  try {
    const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    await getCurrentWebviewWindow().setBackgroundColor(RELOAD_SURFACE_COLOR);
  } catch {
    // Browser dev and older WebViews may not expose the Tauri background-color API.
  }
}

export function applyReloadNativeBackground(): void {
  void setReloadNativeBackground();
}

export function applyReloadSurfaceBackground(): void {
  applyReloadDocumentBackground();
  applyReloadNativeBackground();
}
