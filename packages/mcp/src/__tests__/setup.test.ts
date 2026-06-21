/**
 * First-run / bad-key onboarding surface — the activation path that replaces a
 * crash-at-boot with a guided "get a free key" the agent can relay.
 */
import { describe, it, expect } from "vitest";
import {
  SETUP_TOOL,
  SETUP_TOOL_DESCRIPTION,
  KEY_URL,
  isAuthError,
  setupMessage,
} from "../setup.js";

describe("isAuthError", () => {
  it("treats 401 and 403 as auth errors (rejected key)", () => {
    expect(isAuthError({ status: 401 })).toBe(true);
    expect(isAuthError({ status: 403 })).toBe(true);
  });
  it("does not treat outages / other errors as auth", () => {
    expect(isAuthError({ status: 500 })).toBe(false);
    expect(isAuthError({ status: 0 })).toBe(false); // network error
    expect(isAuthError(new Error("boom"))).toBe(false);
    expect(isAuthError(null)).toBe(false);
    expect(isAuthError(undefined)).toBe(false);
  });
});

describe("setupMessage", () => {
  for (const reason of ["no-key", "bad-key"] as const) {
    it(`(${reason}) gives the agent an actionable, relayable path`, () => {
      const msg = setupMessage(reason);
      expect(msg).toContain(KEY_URL); // where to create the key
      expect(msg).toContain("CODESPAR_API_KEY"); // what to set
      expect(msg.toLowerCase()).toContain("restart"); // how to apply
      expect(msg.toLowerCase()).toContain("user"); // relay to the human
    });
  }
  it("no-key vs bad-key lead with different framing", () => {
    expect(setupMessage("bad-key").toLowerCase()).toContain("rejected");
    expect(setupMessage("no-key").toLowerCase()).not.toContain("rejected");
  });
});

describe("setup tool surface", () => {
  it("names the onboarding tool and sells the value (so the agent surfaces it)", () => {
    expect(SETUP_TOOL).toBe("codespar_get_started");
    expect(SETUP_TOOL_DESCRIPTION.toLowerCase()).toContain("free api key");
    expect(SETUP_TOOL_DESCRIPTION).toMatch(/Pix|commerce/i);
  });
});
