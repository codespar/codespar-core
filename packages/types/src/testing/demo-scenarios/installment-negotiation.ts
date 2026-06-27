import type { DemoScenario } from "../demo-scenario.js";

/* Installment-negotiation demo, expressed at the meta-tool abstraction.
 *
 * A buyer negotiates how to pay for a R$4.800 sofa over three WhatsApp turns:
 * the agent presents options, the buyer asks for a specific term (6x), and the
 * agent closes the sale. Only the final turn touches commerce: the agent calls
 * `codespar_pay` (create the 6x installment payment), `codespar_invoice` (issue
 * the NF-e), and `codespar_notify` (confirm over WhatsApp) — never a raw
 * `serverId__tool`.
 *
 * Why the first two turns call no tools: at the meta-tool abstraction the
 * agent reasons about the no-interest installment math itself (R$4.800 / 6 =
 * R$800) rather than calling a raw PSP preview tool. The meta-tool layer owns
 * *execution*, not quoting — so the negotiation is text, and only the commit is
 * a tool call. That is the cleaner meta-tool shape. Consume the scenario by
 * importing `INSTALLMENT_NEGOTIATION_SCENARIO`.
 *
 * `mocks` is keyed on the meta-tool name so the fixture is returned regardless
 * of how a runtime routes the meta-tool to underlying providers (Asaas for the
 * payment, Nuvem Fiscal for the NF-e, Z-API for WhatsApp).
 */
export const INSTALLMENT_NEGOTIATION_SCENARIO: DemoScenario = {
  name: "installment-negotiation",
  servers: ["asaas", "nuvem-fiscal", "z-api"],
  mocks: {
    codespar_pay: {
      id: "pay_demo_inst_001",
      status: "PENDING",
      method: "card",
      installments: 6,
      installment_value: 80000,
    },
    codespar_invoice: { id: "nfe_demo_001", status: "autorizada", pdf_url: "https://example.test/nfe_demo_001.pdf" },
    codespar_notify: { messageId: "msg_demo_001", sent: true },
  },
  turns: [
    {
      message:
        "Oi! Quero o sofá de R$4.800 que vi no site. Qual a melhor forma de pagar?",
      expectMetaTools: [],
    },
    {
      message: "Em 6x dá pra fechar?",
      expectMetaTools: [],
    },
    {
      message: "Confirma, pode fechar. Manda a confirmação no WhatsApp +5511987654321.",
      expectMetaTools: ["codespar_pay", "codespar_invoice", "codespar_notify"],
    },
  ],
  aimockFixtures: {
    fixtures: [
      {
        match: { userMessage: "melhor forma de pagar", turnIndex: 0, hasToolResult: false },
        response: {
          content:
            "Oba! O sofá de R$4.800 sai super bem em duas opções: (a) Pix com 8% de desconto, fechando em R$4.416,00 à vista; ou (b) 12x no cartão de crédito em parcelas iguais de R$400,00, sem entrada. Qual prefere?",
          finishReason: "stop",
        },
      },
      {
        match: { userMessage: "6x", turnIndex: 0, hasToolResult: false },
        response: {
          content:
            "Em 6x no cartão fica R$800,00 por mês, sem entrada e sem juros. Posso fechar nessa condição?",
          finishReason: "stop",
        },
      },
      {
        match: { userMessage: "Confirma", turnIndex: 0, hasToolResult: false },
        response: {
          toolCalls: [
            {
              name: "codespar_pay",
              arguments: {
                amount: 480000,
                currency: "BRL",
                method: "card",
                description: "Sofá 3 lugares — 6x no cartão, sem juros",
              },
            },
            {
              name: "codespar_invoice",
              arguments: {
                type: "nfe",
                recipient: { name: "Cliente Demo", document: "00000000000" },
                items: [{ description: "Sofá 3 lugares", amount: 4800.0 }],
              },
            },
            {
              name: "codespar_notify",
              arguments: {
                channel: "whatsapp",
                to: "+5511987654321",
                message:
                  "Pedido fechado em 6x de R$800,00. NF-e emitida: https://example.test/nfe_demo_001.pdf",
              },
            },
          ],
          finishReason: "tool_calls",
        },
      },
      {
        match: { userMessage: "Confirma", turnIndex: 1, hasToolResult: true },
        response: {
          content:
            "Pedido fechado em 6x de R$800,00. NF-e emitida e enviada no WhatsApp. Bem-vindo à casa nova!",
          finishReason: "stop",
        },
      },
    ],
  },
};
