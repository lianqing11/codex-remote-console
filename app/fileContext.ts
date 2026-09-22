export type FileContextChip = {
  id: string;
  path: string;
  startLine: number | null;
  endLine: number | null;
  text: string;
};

export type FileMentionHit = {
  path: string;
  name: string;
};

export const MAX_RANGE_LINES = 200;
export const MAX_CHIPS = 6;
export const MAX_TOTAL_LINES = 800;

export function chipId(path: string) {
  return `file-ctx:${path}`;
}

export function chipLabel(chip: FileContextChip) {
  if (chip.startLine && chip.endLine) {
    return chip.startLine === chip.endLine
      ? `${chip.path}:${chip.startLine}`
      : `${chip.path}:${chip.startLine}-${chip.endLine}`;
  }
  return chip.path;
}

export function chipLineCount(chip: FileContextChip) {
  if (chip.startLine && chip.endLine) return Math.max(1, chip.endLine - chip.startLine + 1);
  if (!chip.text) return 0;
  return chip.text.split("\n").length;
}

export function chipOverLimit(chip: FileContextChip) {
  return chipLineCount(chip) > MAX_RANGE_LINES;
}

export function upsertChip(chips: FileContextChip[], next: Omit<FileContextChip, "id">) {
  const chip: FileContextChip = { ...next, id: chipId(next.path) };
  const index = chips.findIndex((item) => item.path === next.path);
  if (index >= 0) {
    const copy = chips.slice();
    copy[index] = chip;
    return copy;
  }
  if (chips.length >= MAX_CHIPS) return [...chips.slice(1), chip];
  return [...chips, chip];
}

export function removeChip(chips: FileContextChip[], id: string) {
  return chips.filter((chip) => chip.id !== id);
}

const mentionPattern = /(?:^|[\s])@([^\s@]+?)(?::(\d+)(?:-(\d+))?)?(?=\s|$)/g;
const ignoredMentionSegments = new Set([".git", ".next", "build", "dist", "node_modules"]);

export function looksLikeFilePath(path: string) {
  if (!path || path === "." || path === "..") return false;
  return path.includes("/") || /\.[A-Za-z0-9]{1,12}$/.test(path);
}

export function isMentionablePath(path: string) {
  return Boolean(path) && !path.split("/").some((segment) => ignoredMentionSegments.has(segment));
}

export function parseAtMentions(text: string) {
  const mentions: Array<{ path: string; startLine: number | null; endLine: number | null }> = [];
  const seen = new Set<string>();
  mentionPattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = mentionPattern.exec(text))) {
    const path = match[1].replace(/[.,;:]+$/, "");
    if (!path || seen.has(path) || !looksLikeFilePath(path)) continue;
    seen.add(path);
    const start = match[2] ? Number(match[2]) : null;
    const end = match[3] ? Number(match[3]) : start;
    mentions.push({ path, startLine: start, endLine: end });
  }
  return mentions;
}

export function activeAtQuery(text: string, cursor: number) {
  if (text.startsWith("/") && !text.slice(0, cursor).includes(" ")) return null;
  const before = text.slice(0, cursor);
  const match = /(?:^|[\s])@([^\s]*)$/.exec(before);
  if (!match) return null;
  if (/:\d+(?:-\d+)?$/.test(match[1])) return null;
  return { start: before.lastIndexOf("@"), query: match[1] };
}

export function shouldInlineChip(chip: FileContextChip, chips: FileContextChip[]) {
  if (!chip.text || chipOverLimit(chip)) return false;
  let used = 0;
  for (const item of chips) {
    if (!item.text || chipOverLimit(item)) continue;
    const count = chipLineCount(item);
    if (item.id === chip.id) return used + count <= MAX_TOTAL_LINES;
    used += count;
  }
  return false;
}

export function sliceFileLines(content: string, startLine: number | null, endLine: number | null) {
  if (!startLine || !endLine) return "";
  return content.split("\n").slice(startLine - 1, endLine).join("\n");
}

export function expandFileContext(text: string, chips: FileContextChip[]) {
  const mentions: string[] = [];
  const fences: string[] = [];
  for (const chip of chips) {
    const mention = `@${chipLabel(chip)}`;
    if (!text.includes(mention)) mentions.push(mention);
    if (!shouldInlineChip(chip, chips)) continue;
    const header = chip.startLine && chip.endLine
      ? `${chip.startLine}:${chip.endLine}:${chip.path}`
      : chip.path;
    fences.push(`\`\`\`${header}\n${chip.text}\n\`\`\``);
  }
  return [text.trim(), mentions.join(" "), ...fences].filter(Boolean).join("\n\n");
}
