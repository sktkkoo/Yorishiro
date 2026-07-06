const DEFAULT_SHELL_LABEL = "~";
const MAX_PERSONA_LABEL_LENGTH = 18;
const MAX_SHELL_LABEL_LENGTH = 24;

export function formatMainSessionTabLabel(personaName: string | null | undefined): string {
  const label = personaName?.trim() || "Agent";
  return truncateMiddle(label, MAX_PERSONA_LABEL_LENGTH);
}

export function formatShellSessionTabLabel(cwd: string | null | undefined): string {
  return truncateMiddle(formatPathLabel(cwd), MAX_SHELL_LABEL_LENGTH);
}

export function formatPathLabel(path: string | null | undefined): string {
  return compactHomePath(path?.trim() || DEFAULT_SHELL_LABEL);
}

export function compactHomePath(path: string): string {
  if (path === "" || path === "~") return DEFAULT_SHELL_LABEL;
  if (path.startsWith("~/")) return path;

  const home = inferHomeDir(path);
  if (home === null) return path;
  if (path === home) return DEFAULT_SHELL_LABEL;
  if (path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`;
  return path;
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

function inferHomeDir(path: string): string | null {
  const userMatch = /^\/Users\/[^/]+(?:\/|$)/.exec(path);
  if (userMatch) return userMatch[0].replace(/\/$/, "");

  const homeMatch = /^\/home\/[^/]+(?:\/|$)/.exec(path);
  if (homeMatch) return homeMatch[0].replace(/\/$/, "");

  return null;
}
