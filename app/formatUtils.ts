import { epochSeconds } from "./threadModel";

export { epochSeconds };

export function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function formatTime(timestamp: number) {
  const seconds = epochSeconds(timestamp);
  if (!seconds) return "";
  return new Date(seconds * 1000).toLocaleString();
}
