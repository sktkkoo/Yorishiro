/**
 * Attention producer の共通 contract。
 *
 * 各 producer は `start*Producer({ attention, ...deps })` の関数として
 * export し、Disposable を返す。dispose で event listener / RAF / timer /
 * subscription を完全に外す（hot-reload 安全のため）。
 *
 * Internal design-record: 2026-04-25-attention-aura-v2-design.md
 * 「Producer の集約場所 (B 案)」section
 */

import type { Disposable } from "@charminal/sdk";

export type { Disposable };
