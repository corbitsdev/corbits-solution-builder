import { describe, expect, test } from "bun:test";
import { hubProxyAllowed, hubProxyHeaders, remoteHubHeaders, stripHubProxyCookies } from "./hub-proxy.js";

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

describe("hubProxyAllowed", () => {
  test("forwards installer and workflow routes", () => {
    expect(hubProxyAllowed("GET", "/api/me")).toBe(true);
    expect(hubProxyAllowed("GET", "/api/me/principals?limit=100")).toBe(true);
    expect(hubProxyAllowed("GET", "/api/tenants?parentId=t_workspace")).toBe(true);
    expect(hubProxyAllowed("GET", "/api/tenants/t_project")).toBe(true);
    expect(hubProxyAllowed("PATCH", "/api/tenants/t_project")).toBe(true);
    expect(hubProxyAllowed("POST", "/api/tenants", { name: "Work", slug: "sb-1", parentId: "t_workspace" })).toBe(
      true,
    );
    expect(hubProxyAllowed("POST", "/api/tenants/t_workspace/roles")).toBe(true);
    expect(hubProxyAllowed("POST", "/api/tenants/t_workspace/workflows/deployments")).toBe(true);
  });

  test("refuses git-tokens, auth, and creating a root tenant", () => {
    expect(hubProxyAllowed("POST", "/api/me/git-tokens")).toBe(false);
    expect(hubProxyAllowed("GET", "/api/tenants/t_workspace/git-tokens")).toBe(false);
    expect(hubProxyAllowed("POST", "/api/auth/sign-in/email")).toBe(false);
    expect(hubProxyAllowed("GET", "/api/auth/get-session")).toBe(false);
    expect(hubProxyAllowed("POST", "/api/tenants", { name: "Solutions Builder", slug: "solutions-builder" })).toBe(
      false,
    );
    expect(hubProxyAllowed("GET", "/api/tenants")).toBe(false);
    expect(hubProxyAllowed("POST", "/api/tenants/t_workspace/runs")).toBe(false);
    // Catalog rerank is a host `/api` route, not a hub proxy hole, and
    // creating a root tenant stays refused.
    expect(hubProxyAllowed("POST", "/api/catalog/rerank")).toBe(false);
    expect(hubProxyAllowed("POST", "/api/tenants")).toBe(false);
  });
});

describe("stripHubProxyCookies", () => {
  test("drops Set-Cookie so the browser never holds the hub session", () => {
    const inbound = new Response("ok", {
      status: 200,
      headers: {
        "content-type": "application/json",
        "set-cookie": "better-auth.session_token=owner; HttpOnly",
      },
    });
    const stripped = stripHubProxyCookies(inbound);
    expect(stripped.headers.get("set-cookie")).toBeNull();
    expect(stripped.headers.get("content-type")).toBe("application/json");
  });
});

describe("remoteHubHeaders", () => {
  test("preserves cookie and content-type from a Headers object", () => {
    const inbound = new Headers({
      cookie: "better-auth.session_token=owner",
      "content-type": "application/json",
    });
    const headers = remoteHubHeaders(inbound, "remote-token");
    expect(headers.get("cookie")).toBe("better-auth.session_token=owner");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("authorization")).toBe("Bearer remote-token");
  });
});
