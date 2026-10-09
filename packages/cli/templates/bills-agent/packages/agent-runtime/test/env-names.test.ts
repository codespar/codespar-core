/**
 * The kit reads `CODESPAR_API_URL` and `CODESPAR_PROJECT_ID`; the CodeSpar CLI
 * reads `CODESPAR_BASE_URL` and `CODESPAR_PROJECT`. A shell set up for one
 * must not send the other to production in silence: the kit takes the CLI's
 * names as aliases, and refuses to start when the two names disagree.
 */
import { describe, expect, it } from "vitest";
import { EnvNamesDisagreeError, reconcileEnvNames } from "../src/env.js";

const STAGING = "https://api.staging.codespar.dev";

describe("reconcileEnvNames", () => {
  it("fills the kit's names from the CLI's when only the CLI's are set", () => {
    const env: NodeJS.ProcessEnv = { CODESPAR_BASE_URL: STAGING, CODESPAR_PROJECT: "prj_cli" };
    reconcileEnvNames(env);
    expect(env["CODESPAR_API_URL"]).toBe(STAGING);
    expect(env["CODESPAR_PROJECT_ID"]).toBe("prj_cli");
  });

  it("fills the CLI's names from the kit's too, so a .env read later cannot reopen a pair the shell closed", () => {
    const env: NodeJS.ProcessEnv = { CODESPAR_API_URL: STAGING, CODESPAR_PROJECT_ID: "prj_kit" };
    reconcileEnvNames(env);
    expect(env["CODESPAR_BASE_URL"]).toBe(STAGING);
    expect(env["CODESPAR_PROJECT"]).toBe("prj_kit");
  });

  it("leaves the kit's names alone when the CLI's are unset or empty", () => {
    const env: NodeJS.ProcessEnv = { CODESPAR_API_URL: STAGING, CODESPAR_BASE_URL: "", CODESPAR_PROJECT_ID: "prj_kit" };
    reconcileEnvNames(env);
    expect(env["CODESPAR_API_URL"]).toBe(STAGING);
    expect(env["CODESPAR_PROJECT_ID"]).toBe("prj_kit");
  });

  it("treats an empty kit name as unset, as the CLI does with its own", () => {
    const env: NodeJS.ProcessEnv = { CODESPAR_API_URL: "", CODESPAR_BASE_URL: STAGING };
    reconcileEnvNames(env);
    expect(env["CODESPAR_API_URL"]).toBe(STAGING);
  });

  it("accepts both names when they say the same thing, a trailing slash aside", () => {
    const env: NodeJS.ProcessEnv = { CODESPAR_API_URL: STAGING, CODESPAR_BASE_URL: `${STAGING}/`, CODESPAR_PROJECT_ID: "prj_1", CODESPAR_PROJECT: "prj_1" };
    expect(() => reconcileEnvNames(env)).not.toThrow();
    expect(env["CODESPAR_API_URL"]).toBe(STAGING);
  });

  it("refuses two URLs that disagree, naming both", () => {
    const env: NodeJS.ProcessEnv = { CODESPAR_API_URL: "https://api.codespar.dev", CODESPAR_BASE_URL: STAGING };
    expect(() => reconcileEnvNames(env)).toThrow(EnvNamesDisagreeError);
    expect(() => reconcileEnvNames(env)).toThrow(/CODESPAR_API_URL=https:\/\/api\.codespar\.dev.*CODESPAR_BASE_URL=https:\/\/api\.staging\.codespar\.dev/);
  });

  it("refuses two projects that disagree, naming both", () => {
    const env: NodeJS.ProcessEnv = { CODESPAR_PROJECT_ID: "prj_kit", CODESPAR_PROJECT: "prj_cli" };
    expect(() => reconcileEnvNames(env)).toThrow(/CODESPAR_PROJECT_ID=prj_kit.*CODESPAR_PROJECT=prj_cli/);
  });
});
