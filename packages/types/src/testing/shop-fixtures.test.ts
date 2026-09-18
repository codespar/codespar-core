/**
 * The shop fixtures are published (`@codespar/types/testing/shop-fixtures`) and
 * mirrored by hand into the Python parity fixture, so two things can rot
 * silently, and both had:
 *
 *   1. `pix_copia_e_cola` carried `0136cks-fixture...`: 36 characters declared
 *      for an 11-character key, closed by a placeholder `6304ABCD`. The API's
 *      reader refuses that payload since codespar-enterprise#1427, and the
 *      lenient reader it replaced answered `cks-fixture5204000053039865802BR6304`
 *      for it — a key nobody can be paid at.
 *   2. Nothing compared the TS constant with the JSON the Python tests read.
 *
 * The EMV rules are re-stated here rather than imported: the parser lives in the
 * API, and this package must not depend on it. Keeping the check on the READER's
 * side is the point — a fixture only earns the name if a reader can read it.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SHOP_STATUS_READY_FIXTURE } from "./shop-fixtures.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PYTHON_FIXTURE = join(HERE, "..", "..", "..", "python", "tests", "_fixtures", "shop_canonical.json");

/** CRC16/CCITT-FALSE, the checksum EMV field 63 carries. */
function crc16Ccitt(payload: string): number {
  let crc = 0xffff;
  for (const byte of new TextEncoder().encode(payload)) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/** Every top-level field, refusing a length that does not land on a boundary. */
function fields(payload: string): Map<string, string> {
  const out = new Map<string, string>();
  let pos = 0;
  while (pos < payload.length) {
    const length = payload.slice(pos + 2, pos + 4);
    expect(length, `length field at ${pos} is not two digits`).toMatch(/^[0-9]{2}$/);
    const end = pos + 4 + Number(length);
    expect(end, `field at ${pos} runs past the payload`).toBeLessThanOrEqual(payload.length);
    out.set(payload.slice(pos, pos + 2), payload.slice(pos + 4, end));
    pos = end;
  }
  return out;
}

describe("shop fixtures — the payable Pix is a BR Code a reader accepts", () => {
  const emv = SHOP_STATUS_READY_FIXTURE.pix_copia_e_cola!;

  it("parses as EMV-TLV to the last character, and field 63 closes it", () => {
    const top = fields(emv);
    expect(top.get("00")).toBe("01");
    expect(emv.slice(-8, -4)).toBe("6304");
  });

  it("carries the CRC it declares", () => {
    const expected = crc16Ccitt(emv.slice(0, -4)).toString(16).toUpperCase().padStart(4, "0");
    expect(emv.slice(-4).toUpperCase()).toBe(expected);
  });

  it("carries the recebedor key inline, with its real length", () => {
    const template = fields(emv).get("26");
    expect(template, "no merchant account template 26").toBeDefined();
    const sub = fields(template!);
    expect(sub.get("00")).toBe("br.gov.bcb.pix");
    expect(sub.get("01")).toBe("cks-fixture");
  });

  it("is the same string the Python parity fixture reads", () => {
    const mirrored = JSON.parse(readFileSync(PYTHON_FIXTURE, "utf8")) as {
      status_ready_for_payment?: { pix_copia_e_cola?: string };
    };
    expect(mirrored.status_ready_for_payment?.pix_copia_e_cola).toBe(emv);
  });
});
