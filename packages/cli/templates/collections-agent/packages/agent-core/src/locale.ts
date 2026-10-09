/**
 * The language of the strings the CODE prints: the approval question, the
 * batch gesture, the execution lines, the consent summary, the WhatsApp
 * templates and the refusal details a kit writes. No model writes these.
 *
 * It is not the reply language (`language.ts`). That one is read from each
 * turn the person types and only tells the model how to answer. The locale is
 * fixed for a run and for a conversation, because the question that proposes
 * a payment and the question that approves it must not change language
 * between the two.
 *
 * Resolution: `--locale` on the command, else `locale:` in `agent.yaml`, else
 * `pt-BR`. A conversation a later command comes back to keeps the locale its
 * bundle recorded.
 */
import { z } from "zod";

export const LOCALES = ["pt-BR", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "pt-BR";
export const LocaleSchema = z.enum(LOCALES);

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** A `--locale` value, or the error the command prints next to its usage. */
export function parseLocale(value: string): Locale {
  if (!isLocale(value)) throw new Error(`--locale must be ${LOCALES.join(" or ")}`);
  return value;
}

export function resolveLocale(flag: Locale | undefined, manifest: { locale?: Locale | undefined }): Locale {
  return flag ?? manifest.locale ?? DEFAULT_LOCALE;
}

/**
 * The language code Meta approves a template in. Meta approves a template per
 * (name, language) pair, so an English conversation sends the `en_US` copy of
 * a template and never the `pt_BR` one.
 */
export const WHATSAPP_LANGUAGE: { readonly [L in Locale]: string } = { "pt-BR": "pt_BR", en: "en_US" };

/** One entry per locale. A table missing a locale does not type-check; a key missing from one entry fails `npm run check`. */
export type LocaleTable<T> = { readonly [L in Locale]: T };

/**
 * What differs between the entries of a string table: a key one locale has and
 * another lacks, a string where the other has a function, or a function that
 * takes a different number of arguments. Empty means every key exists in every
 * locale with the same shape. The check reads this at runtime because a kit is
 * TypeScript that `npm run check` does not compile.
 */
export function tableGaps(name: string, table: Partial<Record<Locale, object>>): string[] {
  const gaps: string[] = [];
  const entry = (l: Locale) => table[l] as Record<string, unknown> | undefined;
  for (const locale of LOCALES) if (!entry(locale)) gaps.push(`${name} has no ${locale} entry`);
  const keys = new Set(LOCALES.flatMap((l) => Object.keys(entry(l) ?? {})));
  for (const key of [...keys].sort()) {
    const shapes = LOCALES.map((l) => {
      const value = entry(l)?.[key];
      if (value === undefined) return "missing";
      if (typeof value === "function") return `function/${value.length}`;
      return typeof value === "string" && value.length > 0 ? "string" : `empty ${typeof value}`;
    });
    for (const [i, shape] of shapes.entries()) {
      if (shape === "missing" || shape.startsWith("empty")) gaps.push(`${name}.${key} is ${shape} in ${LOCALES[i]}`);
    }
    if (new Set(shapes.filter((s) => s !== "missing")).size > 1) gaps.push(`${name}.${key} differs in shape across locales: ${LOCALES.map((l, i) => `${l} ${shapes[i]}`).join(", ")}`);
  }
  return gaps;
}

/** `185000` -> `R$ 1.850,00` in pt-BR, `R$1,850.00` in English: the two forms the prompts give the model since #62. */
export function formatBRL(minor: number, locale: Locale): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const cents = String(abs % 100).padStart(2, "0");
  if (locale === "en") return `${sign}R$${Math.floor(abs / 100).toLocaleString("en-US")}.${cents}`;
  return `${sign}R$ ${Math.floor(abs / 100).toLocaleString("pt-BR")},${cents}`;
}

/** `2026-09-30` -> `30/09/2026` in pt-BR; English keeps the ISO date, which reads the same on either side of the Atlantic. */
export function formatDay(iso: string, locale: Locale): string {
  if (locale === "en") return iso;
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}
