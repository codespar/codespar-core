/**
 * #64: the language of the strings the code prints. Resolved once per run
 * (flag, manifest, default), declared in `agent.yaml` as an optional field,
 * and backed by tables whose every key exists in every locale.
 */
import { describe, expect, it } from "vitest";
import { CORE_STRINGS, DEFAULT_LOCALE, LOCALES, WHATSAPP_LANGUAGE, formatBRL, formatDay, parseLocale, parseManifest, parseTemplateRegistry, resolveLocale, tableGaps } from "../src/index.js";

const MANIFEST = `
schema: 1
name: bills-agent
version: 0.1.0
approval: [human, mandate]
default_approval: human
mcp: "@codespar/mcp@0.5.8"
cli: "@codespar/cli@0.18.1"
tools: ./tools.json
guardrails: ./guardrails.json
mandate_schema: ./mandate.example.json
events: [commerce.payment.succeeded]
channels: [terminal]
maturity:
  pix-out: sandbox
scenarios: ./scenarios/
evals: ./evals/
agents_md: ./AGENTS.md
`;

/** Calls a table entry with placeholder arguments of the arity it declares, so a function key is read as the text it prints. */
function render(value: unknown): string {
  if (typeof value === "string") return value;
  const fn = value as (...args: unknown[]) => string;
  return fn(...Array.from({ length: fn.length }, (_, i) => (i % 2 === 0 ? "X" : 2)));
}

describe("the locale of a run", () => {
  it("is the flag, else the manifest's, else pt-BR", () => {
    expect(resolveLocale("en", { locale: "pt-BR" })).toBe("en");
    expect(resolveLocale(undefined, { locale: "en" })).toBe("en");
    expect(resolveLocale(undefined, {})).toBe("pt-BR");
    expect(DEFAULT_LOCALE).toBe("pt-BR");
  });

  it("is one of the two the kits speak, and anything else is refused by name", () => {
    expect(parseLocale("en")).toBe("en");
    expect(parseLocale("pt-BR")).toBe("pt-BR");
    for (const bad of ["pt", "pt_BR", "en-US", "es", "EN", ""]) expect(() => parseLocale(bad)).toThrow(/--locale must be pt-BR or en/);
  });

  it("is an optional agent.yaml field: absent parses as before, en parses, anything else is refused", () => {
    expect(parseManifest(MANIFEST).locale).toBeUndefined();
    expect(parseManifest(MANIFEST + "locale: en\n").locale).toBe("en");
    expect(parseManifest(MANIFEST + "locale: pt-BR\n").locale).toBe("pt-BR");
    expect(() => parseManifest(MANIFEST + "locale: es\n")).toThrow();
  });

  it("sends a WhatsApp template in the language Meta approved it in for that locale", () => {
    expect(WHATSAPP_LANGUAGE).toEqual({ "pt-BR": "pt_BR", en: "en_US" });
  });

  it("formats money and dates for its reader, from the same minor units", () => {
    expect(formatBRL(185000, "pt-BR")).toBe("R$ 1.850,00");
    expect(formatBRL(185000, "en")).toBe("R$1,850.00");
    expect(formatBRL(-9, "pt-BR")).toBe("-R$ 0,09");
    expect(formatBRL(-9, "en")).toBe("-R$0.09");
    expect(formatDay("2026-09-30", "pt-BR")).toBe("30/09/2026");
    expect(formatDay("2026-09-30", "en")).toBe("2026-09-30");
  });
});

describe("the shared string table", () => {
  it("has every key in every locale, with the same shape", () => {
    expect(tableGaps("CORE_STRINGS", CORE_STRINGS)).toEqual([]);
    expect(Object.keys(CORE_STRINGS.en).sort()).toEqual(Object.keys(CORE_STRINGS["pt-BR"]).sort());
  });

  it("prints text for every key in both locales, and never the word undefined", () => {
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(CORE_STRINGS[locale])) {
        const text = render(value);
        expect(text.trim(), `${locale}.${key}`).not.toBe("");
        expect(text, `${locale}.${key}`).not.toContain("undefined");
      }
    }
  });

  it("offers the answers the parsers read, in the language it asks in", () => {
    expect(CORE_STRINGS["pt-BR"].batchQuestion).toContain("todas / todas exceto 3,7 / nenhuma");
    expect(CORE_STRINGS.en.batchQuestion).toContain("all / all except 3,7 / none");
  });

  it("writes the Portuguese with its accents (#64)", () => {
    const pt = CORE_STRINGS["pt-BR"];
    expect(pt.execution).toBe("execução");
    expect(pt.onlyDeny).toContain("o único desfecho possível é negar");
    expect(pt.boletoLine).toBe("Ou pelo boleto, linha digitável:");
    expect(pt.batchUnreadable(3)).toContain("não entendi");
  });
});

describe("tableGaps: what npm run check reports", () => {
  it("names a key one locale lacks, an empty string, a string against a function, and a different arity", () => {
    const gaps = tableGaps("t", {
      "pt-BR": { a: "a", b: "b", c: (x: string) => x, d: (x: string, y: string) => x + y, e: "" },
      en: { a: "a", c: "c", d: (x: string) => x, e: "e" },
    });
    expect(gaps).toEqual([
      "t.b is missing in en",
      "t.c differs in shape across locales: pt-BR function/1, en string",
      "t.d differs in shape across locales: pt-BR function/2, en function/1",
      "t.e is empty string in pt-BR",
      "t.e differs in shape across locales: pt-BR empty string, en string",
    ]);
  });

  it("names a locale with no entry at all", () => {
    expect(tableGaps("t", { "pt-BR": { a: "a" } })).toContain("t has no en entry");
  });
});

describe("the template registry holds one copy per (name, language)", () => {
  const template = (language: string, extra: Record<string, unknown> = {}) => ({ name: "acordo_quitado", language, description: "paid", body: "{{1}} quitado", ...extra });

  it("accepts the same name in two languages, which is two templates to Meta", () => {
    expect(parseTemplateRegistry(JSON.stringify({ channel: "whatsapp", templates: [template("pt_BR"), template("en_US")] })).templates).toHaveLength(2);
  });

  it("refuses the same pair declared twice", () => {
    expect(() => parseTemplateRegistry(JSON.stringify({ channel: "whatsapp", templates: [template("pt_BR"), template("pt_BR")] }))).toThrow(/acordo_quitado is declared twice in pt_BR/);
  });

  it("refuses one reply id offered by two different templates, which would make a tap ambiguous", () => {
    const button = { id: "emitir_nova", title: "Emitir nova", intent: "emita" };
    const doc = { channel: "whatsapp", templates: [template("pt_BR", { buttons: [button] }), { ...template("pt_BR", { buttons: [button] }), name: "outro" }] };
    expect(() => parseTemplateRegistry(JSON.stringify(doc))).toThrow(/reply id emitir_nova/);
  });
});
