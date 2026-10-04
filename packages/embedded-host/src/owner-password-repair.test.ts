import { describe, expect, test } from "bun:test";
import { repairOwnerPassword } from "./hub-client.js";

// #684: an owner whose keychain password the hub refuses is healed with a fresh one.
describe("repairOwnerPassword", () => {
  test("hashes a fresh password onto the owner's credential row and stores it; nothing when there is no owner", async () => {
    const updates: [string, string][] = [];
    const stored: string[] = [];
    const auth = {
      $context: Promise.resolve({
        internalAdapter: {
          findUserByEmail: async (email: string) => (email === "owner@x.local" ? { user: { id: "usr_1" } } : null),
          updatePassword: async (userId: string, hashed: string) => {
            updates.push([userId, hashed]);
          },
        },
        password: { hash: async (plain: string) => `hash(${plain})` },
      }),
    };
    const fresh = await repairOwnerPassword(auth, "owner@x.local", async (password) => { stored.push(password); }, () => "minted-secret");
    expect(fresh).toBe("minted-secret");
    expect(updates).toEqual([["usr_1", "hash(minted-secret)"]]);
    expect(stored).toEqual(["minted-secret"]);
    expect(await repairOwnerPassword(auth, "nobody@x.local", async () => undefined, () => "x")).toBeNull();
  });
});
