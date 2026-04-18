/**
 * `~/.charminal/` 以下への Tauri invoke wrapper。
 *
 * runtime-wire と同様、Tauri invoke の runtime 依存を test から切り離すため
 * の薄い層。この file 単体の unit test は書かず、production の dev-log で
 * 目視確認する（mock できる value が無い）。
 *
 * Internal design-record: 2026-04-18-phase-1c-rescue-and-mcp.md Section 4.2 / 4.3
 */

import { invoke } from "@tauri-apps/api/core";

/** config.json を text として読む。不在 / 破損は呼び出し側で parse 時に吸収。 */
export async function readCharminalConfigText(): Promise<string> {
  try {
    return await invoke<string>("read_charminal_file", { relativePath: "config.json" });
  } catch {
    // 不在は「File not found」を throw するので、empty string で返す。
    return "";
  }
}

/** config.json を atomic に書く。 */
export async function writeCharminalConfigText(text: string): Promise<void> {
  await invoke("write_charminal_file_atomic", {
    relativePath: "config.json",
    content: text,
  });
}

/** last-startup.json を atomic に書く。 */
export async function writeLastStartupReport(text: string): Promise<void> {
  await invoke("write_charminal_file_atomic", {
    relativePath: "last-startup.json",
    content: text,
  });
}

/** last-startup.json を text として読む。不在 → 空文字列（Rust 側保証）。 */
export async function readLastStartupReport(): Promise<string> {
  return await invoke<string>("read_last_startup_report");
}

/** safe-mode env var を Rust 側で読む。 */
export async function fetchSafeModeFlag(): Promise<boolean> {
  return await invoke<boolean>("is_safe_mode");
}
