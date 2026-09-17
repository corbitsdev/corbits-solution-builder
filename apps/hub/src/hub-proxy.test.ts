import { describe, expect, test } from "bun:test";
import { hubMountPath, hubProxyHeaders, remoteHubHeaders } from "./hub-proxy.js";

describe("hubMountPath", () => {
  test("strips the /hub prefix, including routes the policy proxy used to refuse", () => {
    expect(hubMountPath("/hub/status")).toBe("/status");
    expect(hubMountPath("/hub/api/me")).toBe("/api/me");
    expect(hubMountPath("/hub/api/auth/sign-in/email")).toBe("/api/auth/sign-in/email");
    expect(hubMountPath("/hub/api/auth/get-session")).toBe("/api/auth/get-session");
    expect(hubMountPath("/hub/api/tenants")).toBe("/api/tenants");
    expect(hubMountPath("/hub/api/me/git-tokens")).toBe("/api/me/git-tokens");
    expect(hubMountPath("/hub/api/tenants/t_workspace/git-tokens")).toBe("/api/tenants/t_workspace/git-tokens");
    expect(hubMountPath("/hub/api/catalog/rerank")).toBe("/api/catalog/rerank");
    expect(hubMountPath("/hub/api/tenants", "?parentId=t_workspace")).toBe("/api/tenants?parentId=t_workspace");
  });
});

describe("hubProxyHeaders", () => {
  test("forwards the browser's cookies and drops the host handshake bearer", () => {
    const inbound = new Headers({
      cookie: "solutions_builder_session=host-token; better-auth.session_token=browser",
      authorization: "Bearer host-token",
      accept: "application/json",
    });
    const headers = hubProxyHeaders(inbound);
    expect(headers.get("cookie")).toBe(
      "solutions_builder_session=host-token; better-auth.session_token=browser",
    );
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("accept")).toBe("application/json");
  });

  test("does not attach an owner session when the browser sent none", () => {
    const headers = hubProxyHeaders({ authorization: "Bearer host-token" });
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("authorization")).toBeNull();
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
