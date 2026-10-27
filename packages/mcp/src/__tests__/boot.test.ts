/**
 * The stdio server boots by what the key can do (boot.ts): a 401 is setup
 * mode, a 403 on the session is "no session, keep the REST-backed tools", and
 * an outage still surfaces. Found on 26/10/2026 with a payables-only key that
 * fell into setup mode and never exposed codespar_payables.
 */
import { describe, expect, it } from "vitest";
import type { Session, Tool } from "@codespar/sdk";
import { PAYABLES_TOOL_NAME } from "../payables-tools.js";
import { SHOP_PURCHASE_MCP_TOOLS } from "../shop-purchase-tools.js";
import { NO_SESSION_MESSAGE, bootSession, listedTools } from "../boot.js";

const WALLET: Tool = {
  name: "codespar_wallet",
  description: "Programmable wallet … pix_keys_list | pix_keys_register | pix_keys_delete",
  input_schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["balance", "pix_keys_delete", "pix_keys_list", "pix_keys_register", "receive", "statement"] },
      key_id: { type: "string" },
      confirm: { type: "boolean" },
    },
    required: ["action"],
  },
} as unknown as Tool;

const HOSTED_PAYABLES: Tool = { name: PAYABLES_TOOL_NAME, description: "hosted twin", input_schema: { type: "object" } } as unknown as Tool;

function session(purchases: boolean): Session {
  return { id: "ses_x", ...(purchases ? { purchases: {} } : {}) } as unknown as Session;
}

const apiError = (status: number) => Object.assign(new Error(`http ${status}`), { status });

describe("bootSession", () => {
  it("a key with sessions:create gets its session and the hosted tools", async () => {
    const boot = await bootSession(async () => session(true), async () => [WALLET]);
    expect(boot.kind).toBe("session");
    if (boot.kind === "session") expect(boot.tools).toEqual([WALLET]);
  });

  it("a valid key without sessions:create (403) is no_session, not setup mode", async () => {
    const boot = await bootSession(async () => { throw apiError(403); }, async () => [WALLET]);
    expect(boot).toEqual({ kind: "no_session", status: 403 });
  });

  it("an unknown or revoked key (401) is setup mode", async () => {
    expect(await bootSession(async () => { throw apiError(401); }, async () => [])).toEqual({ kind: "setup" });
  });

  it("an outage still surfaces", async () => {
    await expect(bootSession(async () => { throw apiError(503); }, async () => [])).rejects.toMatchObject({ status: 503 });
    await expect(bootSession(async () => { throw new Error("ECONNRESET"); }, async () => [])).rejects.toThrow("ECONNRESET");
  });
});

describe("listedTools", () => {
  it("without a session, codespar_payables is still offered and nothing that needs a session is", () => {
    const tools = listedTools({ kind: "no_session", status: 403 }, { payables: true });
    expect(tools.map((t) => t.name)).toEqual([PAYABLES_TOOL_NAME]);
    expect(listedTools({ kind: "no_session", status: 403 }, { payables: false })).toEqual([]);
  });

  it("with a session, the hosted codespar_wallet is relayed as published (the pix_keys_* enum and confirm included), plus Shop purchases and payables", () => {
    const tools = listedTools({ kind: "session", session: session(true), tools: [WALLET, HOSTED_PAYABLES] }, { payables: true });
    expect(tools.map((t) => t.name)).toEqual(["codespar_wallet", ...SHOP_PURCHASE_MCP_TOOLS.map((t) => t.name), PAYABLES_TOOL_NAME]);
    const wallet = tools[0]!;
    expect(wallet.inputSchema).toBe(WALLET.input_schema);
    const props = (wallet.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties;
    expect(props.action!.enum).toContain("pix_keys_delete");
    expect(props.confirm).toBeDefined();
    // The hosted twin of codespar_payables is replaced by this server's own (local upload), never listed twice.
    expect(tools.filter((t) => t.name === PAYABLES_TOOL_NAME)).toHaveLength(1);
  });

  it("without Shop purchases on the session, the purchase tools are not offered; without the SDK facade, the hosted payables stays", () => {
    const tools = listedTools({ kind: "session", session: session(false), tools: [WALLET, HOSTED_PAYABLES] }, { payables: false });
    expect(tools.map((t) => t.name)).toEqual(["codespar_wallet", PAYABLES_TOOL_NAME]);
  });

  it("the no-session message names the scope and what still works", () => {
    expect(NO_SESSION_MESSAGE).toContain("sessions:create");
    expect(NO_SESSION_MESSAGE).toContain("codespar_payables");
    expect(NO_SESSION_MESSAGE).toContain("consumers:pix-keys");
  });
});
