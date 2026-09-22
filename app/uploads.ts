import { appPath } from "./apiClient";

export type ServerUpload = {
  id: string;
  name: string;
  contentType: string;
  size: number;
  createdAt: number;
  image: boolean;
};

async function responseBody(response: Response) {
  return response.json().catch(() => ({})) as Promise<{ error?: unknown }>;
}

export async function uploadServerFile(file: File): Promise<ServerUpload> {
  const response = await fetch(appPath(`/api/uploads?name=${encodeURIComponent(file.name || "upload")}`), {
    method: "POST",
    headers: { "content-type": file.type || "application/octet-stream" },
    body: file
  });
  const body = await responseBody(response);
  if (!response.ok) {
    throw new Error(typeof body.error === "string" ? body.error : `Upload failed: ${response.status}`);
  }
  return body as ServerUpload;
}

export async function deleteServerFile(uploadId: string) {
  const response = await fetch(appPath(`/api/uploads/${encodeURIComponent(uploadId)}`), { method: "DELETE" });
  const body = await responseBody(response);
  if (!response.ok) {
    throw new Error(typeof body.error === "string" ? body.error : `Delete failed: ${response.status}`);
  }
}

export function uploadPreviewUrl(uploadId: string) {
  return appPath(`/api/uploads/${encodeURIComponent(uploadId)}`);
}

export function uploadedImagePreviewFromPath(filePath: string) {
  const match = /(?:^|\/)uploads\/([0-9a-f]{8}-[0-9a-f-]{27})\//i.exec(filePath);
  return match ? uploadPreviewUrl(match[1]) : null;
}
