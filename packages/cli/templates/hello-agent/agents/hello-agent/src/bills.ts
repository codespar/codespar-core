/**
 * The month's bills and the one tool the model can reach. A deterministic
 * fixture: the demo has no bank feed, so the agent reads this list. Amounts
 * are BRL cents. The handler reads and returns; it touches nothing.
 */
import type { ToolHandler } from "@codespar/agent-core";

export const MONTH = "2026-10";

export const BILLS = [
  { alias: "escola", name: "Escola Aurora", amount_minor: 185000, due: "2026-10-10" },
  { alias: "mercado", name: "Mercado do Bairro", amount_minor: 64000, due: "2026-10-05" },
  { alias: "contas", name: "Energia (conta de luz)", amount_minor: 31590, due: "2026-10-15" },
];

export function formatBRL(minor: number): string {
  return `R$ ${Math.floor(minor / 100).toLocaleString("pt-BR")},${String(minor % 100).padStart(2, "0")}`;
}

export const listBills: ToolHandler = async () => ({
  month: MONTH,
  bills: BILLS.map((b) => ({ ...b, amount: formatBRL(b.amount_minor) })),
});
