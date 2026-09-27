/**
 * The merchant's catalog and customer book. A deterministic fixture: the demo
 * has no store backend, so the agent reads these, the way the
 * collections-agent reads its book of agreements. The merchant sells
 * SERVICES (lessons, a consultation, a ticket), because a service invoice
 * (NFS-e) runs end to end in the issuer's sandbox and a product invoice
 * (NF-e) does not (checkout §1.1, decision 4).
 *
 * Amounts are BRL cents. `cost_minor` is what the margin floor is computed
 * against and never leaves the code. `service_code` is the item of the
 * national service list (LC 116/2003) the NFS-e names. Availability and
 * stock come from this file, not from any warehouse.
 *
 * The customers' documents are valid CPFs (check digits computed): the
 * clearing house validates the payer of a cobranca com vencimento. `alias`
 * matches the named entries of the sales policy (`mandate.example.json`); the
 * core resolves it to the document, which the model never sees.
 */
export interface CatalogItem {
  sku: string;
  title: string;
  category: "aula" | "avaliacao" | "consultoria" | "ingresso" | "masterclass";
  price_minor: number;
  cost_minor: number;
  available: boolean;
  /** Units that can still be sold; absent means no limit (a lesson is scheduled, not stocked). */
  stock?: number;
  service_code: string;
}

export const MERCHANT = { name: "Estudio Tom Maior", city: "Sao Paulo" } as const;

export const CATALOG: CatalogItem[] = [
  { sku: "aula-avulsa", title: "Aula avulsa de violao (60 min)", category: "aula", price_minor: 10000, cost_minor: 4500, available: true, service_code: "8.02" },
  { sku: "pacote-10-aulas", title: "Pacote de 10 aulas de violao", category: "aula", price_minor: 39000, cost_minor: 30000, available: true, service_code: "8.02" },
  { sku: "avaliacao-inicial", title: "Avaliacao inicial de nivel", category: "avaliacao", price_minor: 8990, cost_minor: 3000, available: true, service_code: "8.02" },
  { sku: "consultoria-1h", title: "Consultoria de carreira musical (1 h)", category: "consultoria", price_minor: 20000, cost_minor: 9000, available: true, service_code: "17.01" },
  { sku: "ingresso-recital", title: "Ingresso para o recital de dezembro", category: "ingresso", price_minor: 4500, cost_minor: 1500, available: true, stock: 4, service_code: "12.07" },
  { sku: "masterclass-producao", title: "Masterclass de producao musical", category: "masterclass", price_minor: 25000, cost_minor: 10000, available: false, service_code: "8.02" },
];

/** Where the service invoice (NFS-e) is delivered: the borrower's registration at the store. */
export interface FiscalAddress {
  street: string;
  number: string;
  district: string;
  postal_code: string;
  city: string;
  /** IBGE code of the municipality. */
  city_code: string;
  state: string;
}

export interface Customer {
  alias: string;
  name: string;
  document: string;
  email: string;
  /** Absent when the customer's registration is incomplete; the issuer refuses a service invoice without it. */
  address?: FiscalAddress;
}

const SAO_PAULO = { city: "Sao Paulo", city_code: "3550308", state: "SP" } as const;

export const CUSTOMERS: Customer[] = [
  { alias: "marina", name: "Marina Costa", document: "27548613008", email: "marina.costa@example.com", address: { street: "Rua Harmonia", number: "120", district: "Vila Madalena", postal_code: "05435000", ...SAO_PAULO } },
  // Registered without an address: every sale to Rafael settles, and its service invoice is refused by the issuer (checkout §4, `nfse-failed`).
  { alias: "rafael", name: "Rafael Lima", document: "86147239031", email: "rafael.lima@example.com" },
  { alias: "beatriz", name: "Beatriz Nunes", document: "43091752879", email: "beatriz.nunes@example.com", address: { street: "Rua Augusta", number: "900", district: "Consolacao", postal_code: "01304001", ...SAO_PAULO } },
];

export function customerByDocument(document: string): Customer | undefined {
  return CUSTOMERS.find((c) => c.document === document);
}

export function catalogItem(sku: string): CatalogItem | undefined {
  const needle = sku.trim().toLowerCase();
  return CATALOG.find((i) => i.sku === needle);
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
