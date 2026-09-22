import { appPath } from "./apiClient";

export type ProjectUploadResult = {
  root: string;
  directory: string;
  path: string;
  name: string;
  size: number;
  modifiedAt: number;
  overwritten: boolean;
};

export class ProjectUploadError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export async function uploadProjectFile({
  root,
  directory,
  file,
  overwrite = false
}: {
  root: string;
  directory: string;
  file: File;
  overwrite?: boolean;
}) {
  const query = new URLSearchParams({
    cwd: root,
    path: directory,
    name: file.name || "upload",
    overwrite: overwrite ? "1" : "0"
  });
  const response = await fetch(appPath(`/api/projects/upload?${query.toString()}`), {
    method: "POST",
    headers: { "content-type": file.type || "application/octet-stream" },
    body: file
  });
  const body = await response.json().catch(() => ({})) as ProjectUploadResult & { error?: unknown };
  if (!response.ok) {
    throw new ProjectUploadError(
      response.status,
      typeof body.error === "string" ? body.error : `Project upload failed: ${response.status}`
    );
  }
  return body;
}
