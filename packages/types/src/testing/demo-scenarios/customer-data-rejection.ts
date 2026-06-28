import type { DemoScenario } from "../demo-scenario.js";

/* Payment-failure triage — customer-data category, at the meta-tool abstraction.
 *
 * The agent attempts a Pix payment; `codespar_pay` returns a *successful* result
 * whose business outcome is a decline with `category: "customer_data"` and
 * `error_code: "INVALID_CPF_CNPJ"`. The irreplaceable judgment is reading that
 * category: a customer-data problem is recoverable by asking the customer for a
 * correction, so the agent notifies the customer (`codespar_notify`), and on the
 * corrected turn retries `codespar_pay` (now confirmed) and issues the NF-e
 * (`codespar_invoice`). No human escalation — the customer can fix the input.
 *
 * The agent never picks a provider: `codespar_pay` owns provider routing
 * internally. What the agent routes is the *remediation* (ask the customer vs.
 * escalate to a human), which is exactly the category-reading judgment a fixed
 * lookup table gets wrong when a new rejection code shows up in production.
 *
 * The first `codespar_pay` mock is a SUCCESSFUL dispatch whose payload is a
 * decline — a rejected payment is a successful API call returning a declined
 * result, so the meta-tool trace still reports `status: "success"`. The agent
 * reads the declined output and drives the correction.
 */
export const CUSTOMER_DATA_REJECTION_SCENARIO: DemoScenario = {
  name: "customer-data-rejection",
  servers: ["asaas", "nuvem-fiscal", "z-api"],
  mocks: {
    // Stateful array: first call is declined for invalid CPF/CNPJ, the retry
    // with the corrected document succeeds.
    codespar_pay: [
      {
        status: "rejected",
        category: "customer_data",
        error_code: "INVALID_CPF_CNPJ",
        reason: "Documento (CPF/CNPJ) do pagador inválido ou não encontrado",
      },
      { id: "pay_demo_triage_001", status: "confirmed", method: "pix" },
    ],
    codespar_notify: { messageId: "msg_demo_triage_001", sent: true },
    codespar_invoice: {
      id: "nfe_demo_triage_001",
      status: "autorizada",
      pdf_url: "https://example.test/nfe_demo_triage_001.pdf",
    },
  },
  turns: [
    {
      message:
        "Quero pagar R$ 2.500 via Pix do meu pedido. Meu CPF é 111.111.111-11.",
      expectMetaTools: ["codespar_pay", "codespar_notify"],
    },
    {
      message: "Foi mal, o CPF correto é 390.533.447-05.",
      expectMetaTools: ["codespar_pay", "codespar_invoice"],
    },
  ],
  aimockFixtures: {
    fixtures: [
      {
        match: { userMessage: "R$ 2.500", turnIndex: 0, hasToolResult: false },
        response: {
          toolCalls: [
            {
              name: "codespar_pay",
              arguments: {
                amount: 250000,
                currency: "BRL",
                method: "pix",
                description: "Pagamento do pedido via Pix",
                consumer_id: "111.111.111-11",
              },
            },
          ],
          finishReason: "tool_calls",
        },
      },
      {
        match: { userMessage: "R$ 2.500", turnIndex: 1, hasToolResult: true },
        response: {
          toolCalls: [
            {
              name: "codespar_notify",
              arguments: {
                channel: "whatsapp",
                to: "+5511987654321",
                message:
                  "O CPF informado é inválido, então não consegui concluir o pagamento. Pode me enviar o CPF correto que eu refaço a cobrança?",
              },
            },
          ],
          finishReason: "tool_calls",
        },
      },
      {
        match: { userMessage: "R$ 2.500", turnIndex: 2, hasToolResult: true },
        response: {
          content:
            "O CPF informado não passou na validação. Me envia o CPF correto que eu refaço o pagamento na hora.",
          finishReason: "stop",
        },
      },
      {
        match: { userMessage: "CPF correto", turnIndex: 0, hasToolResult: false },
        response: {
          toolCalls: [
            {
              name: "codespar_pay",
              arguments: {
                amount: 250000,
                currency: "BRL",
                method: "pix",
                description: "Pagamento do pedido via Pix (CPF corrigido)",
                consumer_id: "390.533.447-05",
              },
            },
          ],
          finishReason: "tool_calls",
        },
      },
      {
        match: { userMessage: "CPF correto", turnIndex: 1, hasToolResult: true },
        response: {
          toolCalls: [
            {
              name: "codespar_invoice",
              arguments: {
                type: "nfe",
                recipient: { name: "Cliente Demo", document: "39053344705" },
                items: [{ description: "Pedido pago via Pix", amount: 2500.0 }],
              },
            },
          ],
          finishReason: "tool_calls",
        },
      },
      {
        match: { userMessage: "CPF correto", turnIndex: 2, hasToolResult: true },
        response: {
          content:
            "Prontinho! Pagamento aprovado com o CPF corrigido e NF-e emitida. Qualquer coisa é só chamar.",
          finishReason: "stop",
        },
      },
    ],
  },
};
