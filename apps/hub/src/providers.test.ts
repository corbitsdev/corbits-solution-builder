import { describe, expect, test } from "bun:test";
import { localEndpointBase } from "./providers.js";

// A local endpoint that connected, listed its models and then refused every
// inference call with a 404 is the failure this guards: the probe normalised
// the URL for itself and the bare one was stored, so `/chat/completions` was
// asked of a root that only serves `/v1/chat/completions`.
describe("localEndpointBase", () => {
  test("adds the version segment the OpenAI-compatible API is served under", () => {
    expect(localEndpointBase("http://localhost:11434")).toBe("http://localhost:11434/v1");
    expect(localEndpointBase("https://host.example")).toBe("https://host.example/v1");
  });

  test("leaves a base that already carries it alone, so connecting twice cannot double it", () => {
    expect(localEndpointBase("http://localhost:11434/v1")).toBe("http://localhost:11434/v1");
    expect(localEndpointBase(localEndpointBase("https://host.example"))).toBe("https://host.example/v1");
  });

  test("ignores trailing slashes, which people type either way", () => {
    expect(localEndpointBase("http://localhost:11434/")).toBe("http://localhost:11434/v1");
    expect(localEndpointBase("http://localhost:11434/v1/")).toBe("http://localhost:11434/v1");
  });
});
