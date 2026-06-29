import type { DemoScenario } from "../demo-scenario.js";

/* Payment-failure triage — non-recoverable category, at the meta-tool abstraction.
 *
 * The agent attempts a Pix payment; `codespar_pay` returns a *successful* result
 * whose business outcome is a decline with `category: "non_recoverable"` and
 * `error_code: "MERCHANT_BLOCKED"`. The irreplaceable judgment is reading that
 * category: a blocked merchant account is NOT something the customer can fix, so
 * the only correct remediation is to notify a human (`codespar_notify` to an
 * internal ops channel) and stop. The agent does NOT retry the payment, does NOT
 * ask the customer for anything, and does NOT issue an invoice.
 *
 * This is the discriminating half of the triage: the same surface
 * (`codespar_pay` returns a decline with a category) routes to a completely
 * different remediation than the customer-data case. A fixed ask-the-customer
 * flow gets this wrong — it would pester the customer about data that is fine
 * while the real fix is a human unblocking the merchant account.
 */
export const MERCHANT_BLOCKED_SCENARIO: DemoScenario = {
  name: "merchant-blocked",
  servers: ["asaas", "z-api"],
  mocks: {
    // Single rejected result — non-recoverable, so there is no retry element.
    codespar_pay: {
      status: "rejected",
      category: "non_recoverable",
      error_code: "MERCHANT_BLOCKED",
      reason: "Conta do lojista bloqueada pelo adquirente",
    },
    codespar_notify: { messageId: "msg_demo_triage_ops_001", sent: true },
  },
  turns: [
    {
      message: "Quero pagar R$ 800 via Pix do pedido #4471.",
      expectMetaTools: ["codespar_pay", "codespar_notify"],
    },
  ],
  aimockFixtures: {
    fixtures: [
      {
        match: { userMessage: "pedido #4471", turnIndex: 0, hasToolResult: false },
        response: {
          toolCalls: [
            {
              name: "codespar_pay",
              arguments: {
                action: "pay",
                amount: 80000,
                currency: "BRL",
                method: "pix",
                description: "Pagamento do pedido #4471 via Pix",
              },
            },
          ],
          finishReason: "tool_calls",
        },
      },
      {
        match: { userMessage: "pedido #4471", turnIndex: 1, hasToolResult: true },
        response: {
          toolCalls: [
            {
              name: "codespar_notify",
              arguments: {
                channel: "slack",
                to: "#payments-ops",
                message:
                  "Pagamento do pedido #4471 bloqueado: conta do lojista MERCHANT_BLOCKED no adquirente. Não é recuperável pelo cliente — escalando para o time resolver.",
              },
            },
          ],
          finishReason: "tool_calls",
        },
      },
      {
        match: { userMessage: "pedido #4471", turnIndex: 2, hasToolResult: true },
        response: {
          content:
            "Não consegui concluir esse pagamento: a conta do lojista está bloqueada no adquirente, o que não dá para resolver pelo seu lado. Já escalei para o time de pagamentos cuidar disso.",
          finishReason: "stop",
        },
      },
    ],
  },
};
