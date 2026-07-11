const DEFAULT_SHELL_LABEL = "~";
const MAX_SHELL_LABEL_LENGTH = 24;
const MAIN_SESSION_TAB_LABEL = "Main Agent";

export interface PathLabelOptions {
  readonly homeDir?: string | null;
}

export function formatMainSessionTabLabel(): string {
  return MAIN_SESSION_TAB_LABEL;
}

export function formatShellSessionTabLabel(
  cwd: string | null | undefined,
  options: PathLabelOptions = {},
): string {
  return truncateMiddle(formatPathLabel(cwd, options), MAX_SHELL_LABEL_LENGTH);
}

export function formatPathLabel(
  path: string | null | undefined,
  options: PathLabelOptions = {},
): string {
  return compactHomePath(path?.trim() || DEFAULT_SHELL_LABEL, options.homeDir);
}

export function compactHomePath(path: string, homeDir?: string | null): string {
  if (path === "" || path === "~") return DEFAULT_SHELL_LABEL;
  if (path.startsWith("~/")) return path;

  const home = normalizeHomeDir(homeDir);
  if (home === null) return path;
  const normalizedPath = trimTrailingSlashes(path);
  if (normalizedPath === home) return DEFAULT_SHELL_LABEL;
  if (normalizedPath.startsWith(`${home}/`)) return `~/${normalizedPath.slice(home.length + 1)}`;
  return normalizedPath;
}

export function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 1) return value.slice(0, maxLength);

  const ellipsis = "…";
  const keep = maxLength - ellipsis.length;
  const headLength = Math.ceil(keep / 2);
  const tailLength = Math.floor(keep / 2);
  return `${value.slice(0, headLength)}${ellipsis}${value.slice(value.length - tailLength)}`;
}

function normalizeHomeDir(homeDir: string | null | undefined): string | null {
  if (homeDir === null || homeDir === undefined) return null;
  const normalized = trimTrailingSlashes(homeDir.trim());
  return normalized === "" || normalized === "/" ? null : normalized;
}

function trimTrailingSlashes(value: string): string {
  return value === "/" ? value : value.replace(/\/+$/, "");
}
