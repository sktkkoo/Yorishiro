/**
 * CharmCommandDispatcher — /charm command の parser + dispatcher。
 *
 * Philosophy: docs/next/charm-command-ux.md
 * SDK surface: src/sdk/context.d.ts の CharmAPI（573）
 *
 * 設計原則:
 *   1. /charm が唯一の入口
 *   2. 引数なしで打てば何かが起きる
 *   3. 未知コマンドは /charm help へ案内
 */

import type { LogEntry } from "@charminal/sdk";

// ─── Types ────────────────────────────────────────────────────

export interface ParsedCommand {
  readonly command: string;
  readonly args: string[];
}

export interface CharmPersonaInfo {
  readonly id: string;
  readonly name: string;
}

/**
 * Narrow read-only view into the runtime. Command handlers depend on this
 * interface rather than concrete primitives — easy to test, easy to extend.
 */
export interface CharmRuntimeView {
  /** Registered personas. All registered are considered active. */
  personas(): CharmPersonaInfo[];
  /** Last N log entries, chronological (oldest first). */
  recentLog(count: number): ReadonlyArray<LogEntry>;
  /** Total log entry count. */
  logSize(): number;
  /** Current time in ms. */
  now(): number;
  /** App start time in ms. */
  readonly startedAt: number;
}

export type CommandExecutor = (args: string[], view: CharmRuntimeView) => string;

export interface CommandEntry {
  readonly description: string;
  readonly execute: CommandExecutor;
}

// ─── Dispatcher ───────────────────────────────────────────────

export class CharmCommandDispatcher {
  private readonly handlers = new Map<string, CommandEntry>();
  private readonly view: CharmRuntimeView;

  constructor(view: CharmRuntimeView) {
    this.view = view;
    this.registerBuiltins();
  }

  /**
   * Parse raw input into command + args. Strips "/charm" prefix if present.
   *
   *   "/charm list"           → { command: "list", args: [] }
   *   "/charm inspect my-pkg" → { command: "inspect", args: ["my-pkg"] }
   *   "/charm"                → { command: "", args: [] }
   *   "list"                  → { command: "list", args: [] }
   */
  parse(input: string): ParsedCommand {
    let remainder = input.trim();
    if (remainder.startsWith("/charm")) {
      remainder = remainder.slice("/charm".length).trim();
    }
    if (remainder === "") {
      return { command: "", args: [] };
    }
    const parts = remainder.split(/\s+/);
    return { command: parts[0], args: parts.slice(1) };
  }

  /** Route a parsed command to the appropriate handler. Returns output text. */
  dispatch(parsed: ParsedCommand): string {
    const handler = this.handlers.get(parsed.command);
    if (handler) {
      return handler.execute(parsed.args, this.view);
    }
    return [
      `"${parsed.command}" は見つかりません。`,
      "/charm help で一覧を確認してください。",
    ].join("\n");
  }

  /** Parse + dispatch in one call. Convenience for CharmAPI adapter. */
  execute(input: string): string {
    return this.dispatch(this.parse(input));
  }

  /** All registered command names (for help / completion). */
  registeredCommands(): string[] {
    return [...this.handlers.keys()];
  }

  /** Register a custom command handler. */
  registerHandler(command: string, entry: CommandEntry): void {
    this.handlers.set(command, entry);
  }

  // ─── Built-in commands ────────────────────────────────────

  private registerBuiltins(): void {
    this.registerHandler("", {
      description: "現在の状態 + できることの一覧",
      execute: statusCommand,
    });
    this.registerHandler("help", {
      description: "全コマンドの詳細ヘルプ",
      execute: helpCommand,
    });
    this.registerHandler("list", {
      description: "インストール済み pack の一覧",
      execute: listCommand,
    });
    this.registerHandler("why", {
      description: "直前の反応の理由を説明",
      execute: whyCommand,
    });
    this.registerHandler("state", {
      description: "詳細な runtime 情報",
      execute: stateCommand,
    });
  }
}

// ─── Command implementations ──────────────────────────────────

/** /charm (no args) — status overview (UX doc: "最も重要な画面") */
function statusCommand(_args: string[], view: CharmRuntimeView): string {
  const personas = view.personas();
  const personaStr = personas.length > 0 ? personas.map((p) => p.name).join(", ") : "(none)";

  return [
    "\u{1F4E6} Charminal Pack",
    "",
    `  active persona:  ${personaStr}`,
    "  active harness:  (none)",
    "  active effect:   (none)",
    "",
    "  /charm list          インストール済みの pack を見る",
    "  /charm why           さっきの反応の理由を見る",
    "  /charm help          全コマンドの詳細ヘルプ",
  ].join("\n");
}

/** /charm help — full command reference */
function helpCommand(): string {
  return [
    "/charm コマンド一覧",
    "",
    "  /charm                現在の状態 + できることの一覧",
    "  /charm list           インストール済み pack の一覧",
    "  /charm why            直前の反応の理由を説明",
    "  /charm state          詳細な runtime 情報",
    "  /charm help           このヘルプを表示",
    "",
    "  coming soon:",
    "  /charm inspect <pack> pack の挙動を説明",
    "  /charm create [type]  新しい pack を作成",
    "  /charm edit <pack>    pack を自然言語で修正",
    "  /charm preview <pack> event をシミュレート",
    "  /charm validate       型 + 意味的 validation",
    "  /charm reload         pack を再読み込み",
  ].join("\n");
}

/** /charm list — pack listing grouped by type */
function listCommand(_args: string[], view: CharmRuntimeView): string {
  const personas = view.personas();
  const lines: string[] = [];

  lines.push("persona:");
  if (personas.length > 0) {
    for (const p of personas) {
      lines.push(`  \u25CF ${p.id}  [active]`);
    }
  } else {
    lines.push("  (none)");
  }

  lines.push("");
  lines.push("harness:");
  lines.push("  (none)");

  lines.push("");
  lines.push("effect:");
  lines.push("  (none)");

  lines.push("");
  lines.push("  /charm inspect <name> で詳しく見る");

  return lines.join("\n");
}

/** /charm why — explain the most recent reaction from the log */
function whyCommand(_args: string[], view: CharmRuntimeView): string {
  const entries = view.recentLog(1);
  if (entries.length === 0) {
    return "まだ反応の記録がありません。";
  }

  const e = entries[0];
  const lines = ["さっきの反応:", "", `  reaction:  ${e.reaction}`, `  persona:   ${e.personaId}`];

  if (e.note) {
    lines.push(`  note:      ${e.note}`);
  }

  lines.push(`  時刻:      ${formatTimestamp(e.timestamp)}`);

  return lines.join("\n");
}

/** /charm state — detailed runtime diagnostics */
function stateCommand(_args: string[], view: CharmRuntimeView): string {
  const uptimeMs = view.now() - view.startedAt;
  const personas = view.personas();
  const personaStr = personas.length > 0 ? personas.map((p) => p.id).join(", ") : "(none)";

  return [
    "runtime:",
    `  uptime:     ${formatUptime(uptimeMs)}`,
    `  persona:    ${personaStr} (${personas.length} registered)`,
    "  harnesses:  0",
    "  effects:    0",
    `  log:        ${view.logSize()} entries`,
  ].join("\n");
}

// ─── Formatting helpers ───────────────────────────────────────

function formatUptime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
