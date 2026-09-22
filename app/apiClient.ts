const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

export function appPath(path: string) {
  return `${basePath}${path}`;
}

export async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(appPath(path));
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : `Request failed: ${response.status}`);
  }
  return body as T;
}

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(appPath(path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof (result as { error?: unknown }).error === "string" ? (result as { error: string }).error : `Request failed: ${response.status}`);
  }
  return result as T;
}
