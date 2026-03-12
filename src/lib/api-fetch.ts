import { getUserId } from "./fingerprint";

export function apiFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const userId = getUserId();
  const headers = new Headers(options.headers);
  if (userId) headers.set("x-user-id", userId);
  return fetch(url, { ...options, headers });
}
