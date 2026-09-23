/**
 * The merchant's open agreements. A deterministic fixture: the demo has no
 * ERP feed, so the agent reads this book. Amounts are BRL cents. `alias`
 * matches the named entries of the collection policy (`mandate.example.json`);
 * the core resolves it to the debtor's document, which the model never sees.
 * The documents are valid CPFs (check digits computed): the clearing house
 * validates them on a cobranca com vencimento.
 */
export interface Agreement {
  alias: string;
  debtor: string;
  first_name: string;
  document: string;
  principal_minor: number;
  origin: string;
  opened_at: string;
}

export const AGREEMENTS: Agreement[] = [
  { alias: "acordo-1042", debtor: "Joana Ribeiro", first_name: "Joana", document: "11144477735", principal_minor: 120000, origin: "pedido #1042, duas parcelas em atraso", opened_at: "2026-08-15" },
  { alias: "acordo-1077", debtor: "Carlos Mendes", first_name: "Carlos", document: "52998224725", principal_minor: 600000, origin: "pedido #1077, fatura vencida em julho", opened_at: "2026-08-02" },
  { alias: "acordo-1103", debtor: "Ana Paula Souza", first_name: "Ana Paula", document: "39053344705", principal_minor: 45000, origin: "pedido #1103, saldo restante", opened_at: "2026-09-01" },
];

export function agreementByAlias(alias: string): Agreement | undefined {
  const needle = alias.trim().toLowerCase();
  return AGREEMENTS.find((a) => a.alias === needle);
}

export function agreementByDocument(document: string): Agreement | undefined {
  return AGREEMENTS.find((a) => a.document === document);
}

export function formatBRL(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const reais = Math.floor(abs / 100).toLocaleString("pt-BR");
  return `${sign}R$ ${reais},${String(abs % 100).padStart(2, "0")}`;
}

/** `2026-09-30` -> `30/09/2026`. */
export function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}
