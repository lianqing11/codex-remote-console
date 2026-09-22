export type ProjectTreeEntry = {
  name: string;
  path: string;
  kind: "directory" | "file";
  size: number | null;
  modifiedAt: number | null;
  extension: string | null;
  symlink: boolean;
  accessible: boolean;
};

export type ProjectTreeListing = {
  root: string;
  path: string;
  parent: string | null;
  entries: ProjectTreeEntry[];
  truncated: boolean;
};

export type ProjectFilePreview = {
  root: string;
  path: string;
  name: string;
  size: number;
  modifiedAt: number;
  content: string | null;
  binary: boolean;
  tooLarge: boolean;
  viewer: "markdown" | "code" | "text" | "unsupported";
  language: string;
};

export type ProjectReference =
  | { kind: "anchor"; href: string }
  | { kind: "external"; href: string }
  | { kind: "project"; path: string; hash: string }
  | { kind: "blocked"; href: "#" };

const allowedExternalProtocols = new Set(["http:", "https:", "mailto:"]);

export function resolveProjectReference(currentFile: string, href: string): ProjectReference {
  const trimmed = href.trim();
  if (!trimmed) return { kind: "blocked", href: "#" };
  if (trimmed.startsWith("#")) return { kind: "anchor", href: trimmed };

  const protocol = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed)?.[1];
  if (protocol) {
    const normalized = `${protocol.toLowerCase()}:`;
    return allowedExternalProtocols.has(normalized)
      ? { kind: "external", href: trimmed }
      : { kind: "blocked", href: "#" };
  }
  if (trimmed.startsWith("//") || trimmed.startsWith("/")) return { kind: "blocked", href: "#" };

  const [pathWithQuery, hashPart = ""] = trimmed.split("#", 2);
  const pathPart = pathWithQuery.split("?", 1)[0];
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    return { kind: "blocked", href: "#" };
  }
  const base = currentFile.split("/").slice(0, -1);
  const segments = [...base, ...decoded.replace(/\\/g, "/").split("/")];
  const normalized: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!normalized.length) return { kind: "blocked", href: "#" };
      normalized.pop();
      continue;
    }
    normalized.push(segment);
  }
  if (!normalized.length) return { kind: "blocked", href: "#" };
  return { kind: "project", path: normalized.join("/"), hash: hashPart ? `#${hashPart}` : "" };
}

export function projectAssetUrl(basePath: string, root: string, filePath: string) {
  const query = new URLSearchParams({ cwd: root, path: filePath });
  return `${basePath}/api/projects/asset?${query.toString()}`;
}
