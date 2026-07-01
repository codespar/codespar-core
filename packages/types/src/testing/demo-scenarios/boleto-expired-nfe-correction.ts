import type { DemoScenario } from "../demo-scenario.js";

/* Post-purchase fiscal remediation — boleto expired, NF-e amendment window OPEN.
 *
 * A customer messages "I paid the boleto but didn't get my order." The agent
 * queries the payment status (`codespar_pay` action=status) and discovers the boleto
 * is OVERDUE — expired unpaid. The irreplaceable judgment is what comes next:
 * the agent breaks the news collaboratively (`codespar_notify`, never accusing
 * the customer), reads the original NF-e's fiscal state (`codespar_invoice`
 * [status]) and finds it still amendable, so it corrects the document IN PLACE
 * with a correction letter (`codespar_invoice` [amend], which returns a CC-e
 * result), and offers a fresh Pix for the same order (`codespar_pay`). The NF-e
 * is never cancelled.
 *
 * This is the open-window half of the "same discovered state, opposite fiscal
 * remediation" pair: the discovered boleto state is identical to the
 * closed-window scenario, but because the SEFAZ amendment window is still open
 * the legal mechanism is a Carta de Correcao Eletronica (CC-e) in place, not a
 * cancel + reissue.
 *
 * Every mock returns a SUCCESSFUL result whose payload carries business state
 * (status: "OVERDUE"; an amendable authorized NF-e; a CC-e protocol) — a boleto
 * that expired unpaid is still a successful status read, so the meta-tool trace
 * reports `status: "success"`. Result fields mirror the real provider vocabulary
 * (Asaas `OVERDUE`; the NF-e status in canonical BR-fiscal terms — `autorizada`,
 * which the platform normalizes from the provider's own status, e.g. nfe.io
 * `Issued`; a correction-letter protocol) so the demo proves it is
 * live-graduatable.
 */
export const BOLETO_EXPIRED_NFE_CORRECTION_SCENARIO: DemoScenario = {
  name: "boleto-expired-nfe-correction",
  servers: ["asaas", "nfe-io", "z-api"],
  mocks: {
    // codespar_pay is a stateful array: the first call (action=status) reads the
    // expired/unpaid boleto — Asaas `OVERDUE` status; the second call
    // (action=pay) is the fresh Pix charge for the same order — Asaas PENDING +
    // copia-e-cola.
    codespar_pay: [
      {
        id: "pay_demo_boleto_7788",
        status: "OVERDUE",
        billing_type: "BOLETO",
        value: 18900,
        due_date: "2026-06-26",
        reason: "Boleto vencido e não pago",
      },
      {
        id: "pay_demo_pix_7788",
        status: "PENDING",
        method: "pix",
        amount: 18900,
        currency: "BRL",
        pix_copy_paste:
          "00020126360014BR.GOV.BCB.PIX0114+5511999999999520400005303986540518.905802BR5913MERCHANT NAME6009SAO PAULO62070503***6304ABCD",
      },
    ],
    codespar_notify: { messageId: "msg_demo_boleto_7788", sent: true },
    // Stateful array: first call is the status read (amendable), second is the
    // amend, which returns a correction-letter (CC-e) result because the window
    // is open.
    codespar_invoice: [
      {
        action: "status",
        id: "nfe_demo_boleto_7788",
        status: "autorizada",
        amendable: true,
        amendment_window: "open",
        chave: "35260612345678000190550010000077881234567890",
      },
      {
        action: "amend",
        mechanism: "correction_letter",
        id: "nfe_demo_boleto_7788",
        status: "autorizada",
        cce_protocol: "135260000456789",
        sequencia_evento: 1,
      },
    ],
  },
  turns: [
    {
      message:
        "Oi! Paguei o boleto do pedido #7788 semana passada mas até agora não recebi nada. Pode verificar?",
      expectMetaTools: [
        "codespar_pay",
        "codespar_notify",
        "codespar_invoice",
      ],
    },
  ],
  aimockFixtures: {
    fixtures: [
      {
        match: { userMessage: "#7788", turnIndex: 0, hasToolResult: false },
        response: {
          toolCalls: [
            {
              name: "codespar_pay",
              arguments: { action: "status", payment_id: "pay_demo_boleto_7788" },
            },
          ],
          finishReason: "tool_calls",
        },
      },
      {
        match: { userMessage: "#7788", turnIndex: 1, hasToolResult: true },
        response: {
          toolCalls: [
            {
              name: "codespar_notify",
              arguments: {
                channel: "whatsapp",
                to: "+5511987654321",
                message:
                  "Verifiquei aqui pra você: o boleto do pedido #7788 acabou vencendo antes de a gente receber o pagamento, então ele não foi compensado. Sem problema — já vou organizar tudo e te mando um Pix novo pra concluir o pedido agora mesmo.",
              },
            },
          ],
          finishReason: "tool_calls",
        },
      },
      {
        match: { userMessage: "#7788", turnIndex: 2, hasToolResult: true },
        response: {
          toolCalls: [
            {
              name: "codespar_invoice",
              arguments: {
                action: "status",
                type: "nfe",
                invoice_id: "nfe_demo_boleto_7788",
              },
            },
          ],
          finishReason: "tool_calls",
        },
      },
      {
        match: { userMessage: "#7788", turnIndex: 3, hasToolResult: true },
        response: {
          toolCalls: [
            {
              name: "codespar_invoice",
              arguments: {
                action: "amend",
                type: "nfe",
                invoice_id: "nfe_demo_boleto_7788",
                correction:
                  "Ajuste da forma de pagamento do pedido #7788 de boleto para Pix; valores e itens inalterados.",
                reason: "Boleto vencido sem pagamento; cobrança refeita via Pix.",
              },
            },
          ],
          finishReason: "tool_calls",
        },
      },
      {
        match: { userMessage: "#7788", turnIndex: 4, hasToolResult: true },
        response: {
          toolCalls: [
            {
              name: "codespar_pay",
              arguments: {
                action: "pay",
                amount: 18900,
                currency: "BRL",
                method: "pix",
                description: "Pagamento via Pix do pedido #7788 (boleto vencido)",
              },
            },
          ],
          finishReason: "tool_calls",
        },
      },
      {
        match: { userMessage: "#7788", turnIndex: 5, hasToolResult: true },
        response: {
          content:
            "Resolvido! O boleto tinha vencido, então corrigi a nota fiscal do pedido #7788 com uma carta de correção e gerei um Pix novo pra você concluir agora. Assim que o pagamento cair, o pedido segue normalmente. Qualquer coisa, é só chamar!",
          finishReason: "stop",
        },
      },
    ],
  },
};
