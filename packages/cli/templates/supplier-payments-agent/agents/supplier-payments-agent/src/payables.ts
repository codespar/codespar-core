/**
 * The month's payables, grouped into the batches the company actually runs:
 * suppliers, commissions and payroll. A deterministic fixture, because the
 * demo has no ERP to read. Amounts are BRL cents; `alias` matches the named
 * payees of the mandate and the core resolves it to the pinned Pix key.
 *
 * The lines of a batch live HERE and not in the model's tool call, which is
 * what makes a batch un-fractionable: the model names which batch to run,
 * and the code is what says who is in it and for how much.
 */
export interface PayableLine {
  alias: string;
  name: string;
  amount_minor: number;
  reference: string;
}

export interface Batch {
  ref: string;
  kind: "fornecedores" | "comissoes" | "folha";
  label: string;
  due: string;
  lines: PayableLine[];
}

export const MONTH = "2026-10";

export const BATCHES: Batch[] = [
  {
    ref: "fornecedores-2026-10",
    kind: "fornecedores",
    label: "Fornecedores de outubro",
    due: "2026-10-10",
    lines: [
      { alias: "grafica", name: "Grafica Litoral", amount_minor: 98000, reference: "NF 4471, catalogos" },
      { alias: "insumos", name: "Insumos Atlantico", amount_minor: 125000, reference: "NF 8820, materia-prima" },
      { alias: "logistica", name: "Transporte Verde", amount_minor: 76000, reference: "NF 1290, fretes de setembro" },
    ],
  },
  {
    ref: "comissoes-2026-10",
    kind: "comissoes",
    label: "Comissoes de outubro",
    due: "2026-10-05",
    lines: [
      { alias: "rep-sul", name: "Marcos (representante Sul)", amount_minor: 62000, reference: "comissao sobre setembro" },
      { alias: "rep-norte", name: "Paula (representante Norte)", amount_minor: 48000, reference: "comissao sobre setembro" },
    ],
  },
  {
    ref: "folha-2026-10",
    kind: "folha",
    label: "Folha de outubro",
    due: "2026-10-05",
    lines: [
      { alias: "ana", name: "Ana Ribeiro", amount_minor: 220000, reference: "salario outubro" },
      { alias: "bruno", name: "Bruno Castro", amount_minor: 180000, reference: "salario outubro" },
      { alias: "carla", name: "Carla Dias", amount_minor: 140000, reference: "salario outubro" },
    ],
  },
];

export function findBatch(ref: string): Batch | undefined {
  return BATCHES.find((b) => b.ref === ref);
}

export function batchTotal(batch: Batch): number {
  return batch.lines.reduce((sum, l) => sum + l.amount_minor, 0);
}

export function formatBRL(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const reais = Math.floor(abs / 100).toLocaleString("pt-BR");
  return `${sign}R$ ${reais},${String(abs % 100).padStart(2, "0")}`;
}
