/**
 * The consent is what a person reads before signing a mandate, so its caps
 * are money as a person writes it, not the minor units the API takes.
 */
import { describe, expect, it } from "vitest";
import { STRINGS } from "../src/strings.js";

describe("the consent summary says its amounts in reais", () => {
  it("the three caps, in pt-BR and in English", () => {
    expect(STRINGS["pt-BR"].consentCaps(250000, 600000, 7200000)).toBe("  teto por pagamento: R$ 2.500,00    teto do mês: R$ 6.000,00    vitalício: R$ 72.000,00");
    expect(STRINGS.en.consentCaps(250000, 600000, 7200000)).toBe("  cap per payment: R$2,500.00    cap per month: R$6,000.00    lifetime: R$72,000.00");
  });

  it("the sandbox credit too", () => {
    expect(STRINGS["pt-BR"].consentFunded(600000, "acc_1", "dep_1")).toBe("Sandbox creditado: R$ 6.000,00 em acc_1 (deposit dep_1).");
    expect(STRINGS.en.consentFunded(600000, "acc_1", "dep_1")).toBe("Sandbox credited: R$6,000.00 to acc_1 (deposit dep_1).");
  });

  it("no line of the consent counts in cents", () => {
    for (const locale of ["pt-BR", "en"] as const) {
      const lines = [STRINGS[locale].consentCaps(250000, 600000, 7200000), STRINGS[locale].consentFunded(600000, "acc_1", "dep_1")];
      for (const line of lines) expect(line).not.toMatch(/centavos|cents|250000|600000|7200000/);
    }
  });
});
