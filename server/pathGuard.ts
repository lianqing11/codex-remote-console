import path from "node:path";

export function resolveInsideRoot(root: string, relativePath: string) {
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes selected root: ${relativePath}`);
  }
  return target;
}

export function isInsideRoot(root: string, filePath: string) {
  const relative = path.relative(path.resolve(root), filePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
