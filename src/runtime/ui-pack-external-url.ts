/** Maximum URL length accepted by the UI Pack external-link capability. */
export const UI_PACK_EXTERNAL_URL_MAX_LENGTH = 2_048;

/**
 * Validate and normalize a URL requested by a UI Pack.
 *
 * This is deliberately narrower than Tauri's opener plugin: the public Pack
 * capability only opens absolute HTTPS links without embedded credentials.
 * Native paths, custom schemes, HTTP, and relative URLs remain unavailable.
 */
export function validateUiPackExternalUrl(value: string): string {
  if (value.length === 0 || value.length > UI_PACK_EXTERNAL_URL_MAX_LENGTH) {
    throw new Error("UI Pack external URL must be between 1 and 2048 characters");
  }
  if (value.trim() !== value) {
    throw new Error("UI Pack external URL must not have surrounding whitespace");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("UI Pack external URL must be an absolute HTTPS URL");
  }

  if (url.protocol !== "https:") {
    throw new Error("UI Pack external URL must use HTTPS");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("UI Pack external URL must not contain credentials");
  }

  return url.href;
}
