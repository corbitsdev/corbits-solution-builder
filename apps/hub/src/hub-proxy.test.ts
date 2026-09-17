import { describe, expect, test } from "bun:test";
import { hubProxyHeaders } from "./hub-proxy.js";

describe("hubProxyHeaders", () => {
  test("drops the host handshake and attaches the owner session", () => {
    const inbound = new Headers({
      cookie: "solutions_builder_session=host-token",
      authorization: "Bearer host-token",
      accept: "application/json",
    });
    const headers = hubProxyHeaders(inbound, "better-auth.session_token=owner");
    expect(headers.get("cookie")).toBe("better-auth.session_token=owner");
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("accept")).toBe("application/json");
  });

  test("forwards no inner identity when there is no owner session yet", () => {
    const headers = hubProxyHeaders({ authorization: "Bearer host-token" }, null);
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("authorization")).toBeNull();
  });
});
