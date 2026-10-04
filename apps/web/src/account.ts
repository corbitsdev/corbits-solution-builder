/**
 * The signed-in person as the shell shows them (#682): their initials on
 * the topbar's account control, and the rules the Account settings apply.
 */
import type { HubUser } from "./hub-auth.ts";

/** Up to two initials from a name, or the first letter of the email. */
export function initialsOf(user: Pick<HubUser, "name" | "email">): string {
  const words = user.name.trim().split(/\s+/).filter((word) => word.length > 0 && word !== user.email);
  if (words.length === 0) return (user.email[0] ?? "?").toUpperCase();
  const first = words[0]![0] ?? "";
  const last = words.length > 1 ? (words[words.length - 1]![0] ?? "") : "";
  return `${first}${last}`.toUpperCase();
}

/** Why a new password cannot be set, or null when it can. */
export function passwordProblem(next: string, confirm: string): string | null {
  if (next.length < 8) return "Use at least 8 characters.";
  if (next !== confirm) return "The two entries do not match.";
  return null;
}
