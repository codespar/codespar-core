/**
 * The month's bills. A deterministic fixture: the demo has no bank feed, so
 * the agent reads this list. Amounts are BRL cents. `alias` matches the
 * named payees of the mandate; the core resolves it to the pinned Pix key.
 */
export interface Bill {
  alias: string;
  name: string;
  amount_minor: number;
  due: string;
  reference: string;
}

export const MONTH = "2026-10";

export const BILLS: Bill[] = [
  { alias: "escola", name: "Escola Aurora", amount_minor: 185000, due: "2026-10-10", reference: "mensalidade outubro" },
  { alias: "mercado", name: "Mercado do Bairro", amount_minor: 64000, due: "2026-10-05", reference: "compras da semana" },
  { alias: "funcionaria", name: "Maria (diarista)", amount_minor: 120000, due: "2026-10-05", reference: "diarias de setembro" },
  { alias: "contas", name: "Energia (conta de luz)", amount_minor: 31590, due: "2026-10-15", reference: "fatura 09/2026" },
];

export function formatBRL(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const reais = Math.floor(abs / 100).toLocaleString("pt-BR");
  return `${sign}R$ ${reais},${String(abs % 100).padStart(2, "0")}`;
}
