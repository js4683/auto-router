import { describe, expect, it } from "vitest";
import { loginProviderId } from "../src/login.js";

describe("loginProviderId", () => {
  it("allows known providers and rejects anything else", () => {
    expect(loginProviderId("openai")).toBe("openai");
    expect(loginProviderId("anthropic")).toBe("anthropic");
    expect(loginProviderId("../evil")).toBeUndefined();
    expect(loginProviderId("cursor")).toBeUndefined();
  });
});
