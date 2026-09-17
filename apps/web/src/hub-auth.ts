/**
 * Hub email auth over `/hub/api/auth/*`.
 *
 * Same-origin credentials carry the desktop handshake cookie (the outer door)
 * and, after a successful sign-up or sign-in, Better Auth's session cookie.
 */
import { ApiError } from "@intx/hub-client";

export type HubUser = {
  id: string;
  name: string;
  email: string;
};

export type HubSession = {
  user: HubUser;
} | null;

type AuthJson = {
  user?: { id?: unknown; name?: unknown; email?: unknown } | null;
  session?: unknown;
  message?: unknown;
  error?: { code?: unknown; message?: unknown };
};

async function hubAuth(path: string, init: RequestInit): Promise<{ response: Response; parsed: unknown }> {
  let response: Response;
  try {
    response = await fetch(`/hub/api/auth${path}`, { ...init, credentials: "same-origin" });
  } catch {
    throw new ApiError(
      0,
      "host_unreachable",
      "That request did not reach the host. Try again, or reopen the window.",
    );
  }
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text.length === 0 ? undefined : JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return { response, parsed };
}

function messageOf(parsed: unknown, fallback: string): string {
  const body = parsed as AuthJson | undefined;
  if (typeof body?.message === "string" && body.message.length > 0) return body.message;
  if (typeof body?.error?.message === "string" && body.error.message.length > 0) return body.error.message;
  return fallback;
}

function userOf(parsed: unknown): HubUser | null {
  const user = (parsed as AuthJson | undefined)?.user;
  if (!user || typeof user.id !== "string" || typeof user.email !== "string") return null;
  return {
    id: user.id,
    name: typeof user.name === "string" && user.name.trim().length > 0 ? user.name : user.email,
    email: user.email,
  };
}

export async function getHubSession(): Promise<HubSession> {
  const { response, parsed } = await hubAuth("/get-session", { method: "GET" });
  if (response.status === 401) return null;
  if (!response.ok) {
    throw new ApiError(response.status, "unknown", messageOf(parsed, `HTTP ${response.status}`));
  }
  const user = userOf(parsed);
  return user ? { user } : null;
}

export async function signUpHub(input: { email: string; password: string; name: string }): Promise<HubUser> {
  const { response, parsed } = await hubAuth("/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new ApiError(response.status, "unknown", messageOf(parsed, "Could not create the account."));
  }
  const user = userOf(parsed);
  if (!user) throw new ApiError(response.status, "unknown", "The hub accepted the account but did not return a user.");
  return user;
}

export async function signInHub(input: { email: string; password: string }): Promise<HubUser> {
  const { response, parsed } = await hubAuth("/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new ApiError(response.status, "unknown", messageOf(parsed, "Could not sign in."));
  }
  const user = userOf(parsed);
  if (!user) throw new ApiError(response.status, "unknown", "The hub accepted the sign-in but did not return a user.");
  return user;
}
