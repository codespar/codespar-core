import type { DemoScenario } from "../demo-scenario.js";

/* Payment-rejection / cross-provider routing demo, at the meta-tool abstraction.
 *
 * A Pix payment is rejected because the customer's Pix key is invalid, the agent
 * asks for a corrected key over WhatsApp, and the retry succeeds and issues the
 * NF-e. The agent calls `codespar_pay` twice (reject then retry), `codespar_notify`
 * twice (ask, then confirm), and `codespar_invoice` once — never a raw PSP tool.
 *
 * Why this dissolves the old "second PSP" blocker: at the raw-tool layer this
 * demo needed two PSP servers (e.g. Asaas + PagBank) with demo fixtures to show
 * a fallback. At the meta-tool layer the agent never calls two raw PSPs — it
 * calls `codespar_pay`, which owns provider routing internally. The reject-then-
 * retry judgment lives in the agent (interpret INVALID_PIX_KEY as a customer-data
 * problem → ask for a correction, not blindly retry another PSP), and the routing
 * lives in the meta-tool. One meta-tool, one stateful fixture sequence, both
 * runtimes.
 *
 * The first `codespar_pay` mock is a SUCCESSFUL dispatch whose business outcome
 * is a decline (`status: "rejected"`, `error_code: "INVALID_PIX_KEY"`) — a
 * rejected payment is a successful API call that returns a declined result, so
 * the meta-tool call still reports `status: "success"` at the trace level. The
 * agent reads the declined output and drives the correction.
 */
export const PAYMENT_REJECTION_SCENARIO: DemoScenario = {
  name: "payment-rejection",
  servers: ["asaas", "nuvem-fiscal", "z-api"],
  mocks: {
    // Stateful array: first call is declined, the retry succeeds.
    codespar_pay: [
      {
        status: "rejected",
        error_code: "INVALID_PIX_KEY",
        reason: "Pix key not found or de-registered",
      },
      { id: "pay_demo_pix_001", status: "PENDING", method: "pix" },
    ],
    codespar_notify: { messageId: "msg_demo_001", sent: true },
    codespar_invoice: { id: "nfe_demo_002", status: "autorizada", pdf_url: "https://example.test/nfe_demo_002.pdf" },
  },
  turns: [
    {
      message:
        "Quero pagar R$2.500 via Pix. Minha chave é cliente-demo@pix.invalid",
      expectMetaTools: ["codespar_pay", "codespar_notify"],
    },
    {
      message: "Opa, a chave correta é cliente.demo@banco.com",
      expectMetaTools: ["codespar_pay", "codespar_invoice", "codespar_notify"],
    },
  ],
  aimockFixtures: {
    fixtures: [
      {
        match: { userMessage: "via Pix", turnIndex: 0, hasToolResult: false },
        response: {
          toolCalls: [
            {
              name: "codespar_pay",
              arguments: {
                amount: 250000,
                currency: "BRL",
                method: "pix",
                recipient: "cliente-demo@pix.invalid",
                description: "Pagamento do pedido via Pix",
              },
            },
          ],
          finishReason: "tool_calls",
        },
      },
      {
        match: { userMessage: "via Pix", turnIndex: 1, hasToolResult: true },
        response: {
          toolCalls: [
            {
              name: "codespar_notify",
              arguments: {
                channel: "whatsapp",
                to: "+5511987654321",
                message:
                  "Sua chave Pix não foi encontrada (pode estar de-registrada). Pode me enviar a chave correta?",
              },
            },
          ],
          finishReason: "tool_calls",
        },
      },
      {
        match: { userMessage: "via Pix", turnIndex: 2, hasToolResult: true },
        response: {
          content:
            "A chave Pix informada não foi encontrada. Me envia a chave correta que eu refaço o pagamento.",
          finishReason: "stop",
        },
      },
      {
        match: { userMessage: "chave correta", turnIndex: 0, hasToolResult: false },
        response: {
          toolCalls: [
            {
              name: "codespar_pay",
              arguments: {
                amount: 250000,
                currency: "BRL",
                method: "pix",
                recipient: "cliente.demo@banco.com",
                description: "Pagamento do pedido via Pix (chave corrigida)",
              },
            },
            {
              name: "codespar_invoice",
              arguments: {
                type: "nfe",
                recipient: { name: "Cliente Demo", document: "00000000000" },
                items: [{ description: "Pedido pago via Pix", amount: 2500.0 }],
              },
            },
            {
              name: "codespar_notify",
              arguments: {
                channel: "whatsapp",
                to: "+5511987654321",
                message:
                  "Pagamento aprovado e NF-e emitida: https://example.test/nfe_demo_002.pdf",
              },
            },
          ],
          finishReason: "tool_calls",
        },
      },
      {
        match: { userMessage: "chave correta", turnIndex: 1, hasToolResult: true },
        response: {
          content:
            "Prontinho! Pagamento Pix aprovado com a chave corrigida e NF-e emitida. Enviei o comprovante no WhatsApp.",
          finishReason: "stop",
        },
      },
    ],
  },
};
