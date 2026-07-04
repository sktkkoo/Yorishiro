#!/usr/bin/env node
/**
 * CLI canary — Charminal が依存する agent CLI の公開サーフェス（フラグ / サブコマンド）が
 * 最新版でも生きているかを検証する。壊れた場合、ユーザーより先に CI が気づくための決定論的
 * スクリプト（.github/workflows/cli-canary.yml から毎日実行）。
 *
 * 検証対象のサーフェスは agent adapter が実際に渡すものと 1:1 に保つこと:
 * - claude: src-tauri/src/sessions/agent_adapter/claude.rs (build_launch_args)
 * - codex:  src-tauri/src/sessions/agent_adapter/codex.rs (build_launch_args)
 *
 * ここで検証できるのは「フラグ表面」まで。TUI 文言（許可プロンプト等、
 * screen-attention-detector.ts の regex）は認証済みセッションが必要なため対象外
 * （design-record 2026-07-04-main-agent-autolaunch-rethink.md §5 の future note）。
 *
 * 経緯: design-record 2026-07-04-main-agent-autolaunch-rethink.md §1.3
 */

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

/** @type {{ bin: string, versionArgs: string[], checks: { args: string[], mustContain: string[] }[] }[]} */
const TARGETS = [
  {
    bin: "claude",
    versionArgs: ["--version"],
    checks: [
      {
        args: ["--help"],
        mustContain: [
          "--settings",
          "--mcp-config",
          "--plugin-dir",
          "--append-system-prompt",
          "--continue",
        ],
      },
    ],
  },
  {
    bin: "codex",
    versionArgs: ["--version"],
    checks: [
      { args: ["--help"], mustContain: ["resume", "--config"] },
      { args: ["resume", "--help"], mustContain: ["--last"] },
    ],
  },
];

function run(bin, args) {
  try {
    const stdout = execFileSync(bin, args, {
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output: stdout };
  } catch (err) {
    // --help が exit 0 以外を返す CLI もあるため、出力が取れていれば検証は続ける。
    const output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    if (output.trim().length > 0) {
      return { ok: true, output };
    }
    return { ok: false, output: String(err.message ?? err) };
  }
}

const lines = [];
const failures = [];

for (const target of TARGETS) {
  const version = run(target.bin, target.versionArgs);
  if (!version.ok) {
    failures.push(`${target.bin}: 実行できない（未インストール?）: ${version.output}`);
    lines.push(`- **${target.bin}**: ❌ 実行不能`);
    continue;
  }
  lines.push(`- **${target.bin}** \`${version.output.trim().split("\n")[0]}\``);

  for (const check of target.checks) {
    const label = `${target.bin} ${check.args.join(" ")}`;
    const result = run(target.bin, check.args);
    if (!result.ok) {
      failures.push(`${label}: 実行失敗: ${result.output}`);
      lines.push(`  - ❌ \`${label}\` 実行失敗`);
      continue;
    }
    const missing = check.mustContain.filter((needle) => !result.output.includes(needle));
    if (missing.length > 0) {
      failures.push(`${label}: サーフェス消失: ${missing.join(", ")}`);
      lines.push(`  - ❌ \`${label}\` に無い: ${missing.map((m) => `\`${m}\``).join(", ")}`);
    } else {
      lines.push(`  - ✅ \`${label}\`: ${check.mustContain.map((m) => `\`${m}\``).join(", ")}`);
    }
  }
}

const report = lines.join("\n");
console.log(report);

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## CLI canary\n\n${report}\n`);
}

if (failures.length > 0) {
  console.error("\nCLI サーフェスの破壊を検知:");
  for (const f of failures) {
    console.error(`  - ${f}`);
  }
  console.error(
    "\n対応: agent adapter (src-tauri/src/sessions/agent_adapter/) の該当フラグを確認し、CLI の changelog を参照すること。",
  );
  process.exit(1);
}
