import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./client.ts";
import { keys } from "./keys.ts";

describe("queryClient", () => {
  test("mounts as a provider and renders its children", () => {
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client: queryClient }, createElement("p", null, "ready")));
    expect(html).toBe("<p>ready</p>");
  });

  test("never refetches in a hidden tab, and a clock is a backstop", () => {
    const defaults = queryClient.getDefaultOptions().queries;
    expect(defaults?.refetchIntervalInBackground).toBe(false);
    expect(defaults?.refetchOnWindowFocus).toBe(true);
    expect(defaults?.staleTime).toBe(5_000);
    expect(defaults?.retry).toBe(1);
  });
});

describe("keys", () => {
  test("an instance key is stable across calls and starts with its prefix", () => {
    expect(keys.tenant.of("tnt_1")).toEqual(keys.tenant.of("tnt_1"));
    expect(keys.tenant.of("tnt_1").slice(0, 1)).toEqual([...keys.tenant.all]);
    expect(keys.runEvents.of("t", "d", "r")).toEqual(["runEvents", "t", "d", "r"]);
  });

  test("different instances and different resources never collide", () => {
    expect(keys.tenant.of("a")).not.toEqual(keys.tenant.of("b"));
    expect(keys.tenant.of("a")).not.toEqual(keys.tenants.under("a"));
    expect(keys.deployments.of("a")).not.toEqual(keys.approvals.of("a"));
  });

  test("a thread key does not depend on the order its addresses are given in", () => {
    expect(keys.thread.of("t", ["b@x", "a@x"])).toEqual(keys.thread.of("t", ["a@x", "b@x"]));
  });

  test("the active model key tells the workspace default from a project's stage", () => {
    expect(keys.activeModel.of()).toEqual(["activeModel", null, null]);
    expect(keys.activeModel.of("p", 2)).not.toEqual(keys.activeModel.of());
  });
});
