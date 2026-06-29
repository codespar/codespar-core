import type { DemoScenario } from "../demo-scenario.js";

/* Post-purchase fiscal remediation — boleto expired, NF-e amendment window CLOSED.
 *
 * The discriminating half of the pair. The discovered state is identical to the
 * open-window scenario — the agent queries `codespar_pay` action=status and finds
 * the boleto OVERDUE (expired unpaid), and communicates it collaboratively — but
 * the original NF-e's fiscal state is different: `codespar_invoice` [status]
 * reports it is NO LONGER amendable (the SEFAZ correction-letter window has
 * closed). So the only legal remediation is to CANCEL the original document and
 * reissue it as a substitute (`codespar_invoice` [amend] returns a
 * cancel_and_reissue result carrying a `tipo: 3` Substituto), then offer a fresh
 * Pix (`codespar_pay`).
 *
 * A fixed "always correct in place" flow gets this wrong — it would attempt a
 * CC-e the SEFAZ window no longer permits, producing an invalid fiscal action.
 * Reading the amendment-window state and choosing the legal mechanism (CC-e vs
 * cancel + reissue) is the irreplaceable fiscal judgment.
 *
 * Result fields mirror the real Nuvem Fiscal vocabulary (`autorizada` ->
 * `cancelada`; a substitute document with `tipo: 3`, Substituto) so the demo is
 * live-graduatable.
 */
export const BOLETO_EXPIRED_NFE_REISSUE_SCENARIO: DemoScenario = {
  name: "boleto-expired-nfe-reissue",
  servers: ["asaas", "nuvem-fiscal", "z-api"],
  mocks: {
    // codespar_pay is a stateful array: action=status reads the OVERDUE boleto,
    // then action=pay issues the fresh Pix charge.
    codespar_pay: [
      {
        id: "pay_demo_boleto_9911",
        status: "OVERDUE",
        billing_type: "BOLETO",
        value: 42500,
        due_date: "2026-05-20",
        reason: "Boleto vencido e não pago",
      },
      {
        id: "pay_demo_pix_9911",
        status: "PENDING",
        method: "pix",
        amount: 42500,
        currency: "BRL",
        pix_copy_paste:
          "00020126360014BR.GOV.BCB.PIX0114+5511999999999520400005303986540542.505802BR5913MERCHANT NAME6009SAO PAULO62070503***6304DCBA",
      },
    ],
    codespar_notify: { messageId: "msg_demo_boleto_9911", sent: true },
    // Stateful array: status read reports NOT amendable; the amend therefore
    // cancels the original and reissues it as a substitute (tipo 3).
    codespar_invoice: [
      {
        action: "status",
        id: "nfe_demo_boleto_9911",
        status: "autorizada",
        amendable: false,
        amendment_window: "closed",
        chave: "35260512345678000190550010000099111234567890",
      },
      {
        action: "amend",
        mechanism: "cancel_and_reissue",
        id: "nfe_demo_boleto_9911",
        status: "cancelada",
        cancel_protocol: "135260000998877",
        substitute: {
          id: "nfe_demo_boleto_9911_sub",
          tipo: 3,
          tipo_descricao: "Substituto",
          status: "autorizada",
          chave: "35260612345678000190550010000099120000000001",
        },
      },
    ],
  },
  turns: [
    {
      message:
        "Boa tarde, paguei o boleto do pedido #9911 faz um tempão e o pedido não chegou. O que aconteceu?",
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
        match: { userMessage: "#9911", turnIndex: 0, hasToolResult: false },
        response: {
          toolCalls: [
            {
              name: "codespar_pay",
              arguments: { action: "status", payment_id: "pay_demo_boleto_9911" },
            },
          ],
          finishReason: "tool_calls",
        },
      },
      {
        match: { userMessage: "#9911", turnIndex: 1, hasToolResult: true },
        response: {
          toolCalls: [
            {
              name: "codespar_notify",
              arguments: {
                channel: "whatsapp",
                to: "+5511912345678",
                message:
                  "Acabei de checar pra você: o boleto do pedido #9911 venceu antes de o pagamento ser compensado, por isso o pedido ficou parado. Tranquilo — eu cuido de tudo aqui e já te envio um Pix novo pra finalizar agora.",
              },
            },
          ],
          finishReason: "tool_calls",
        },
      },
      {
        match: { userMessage: "#9911", turnIndex: 2, hasToolResult: true },
        response: {
          toolCalls: [
            {
              name: "codespar_invoice",
              arguments: {
                action: "status",
                type: "nfe",
                invoice_id: "nfe_demo_boleto_9911",
              },
            },
          ],
          finishReason: "tool_calls",
        },
      },
      {
        match: { userMessage: "#9911", turnIndex: 3, hasToolResult: true },
        response: {
          toolCalls: [
            {
              name: "codespar_invoice",
              arguments: {
                action: "amend",
                type: "nfe",
                invoice_id: "nfe_demo_boleto_9911",
                reason:
                  "Janela de correção encerrada; cancelar e reemitir como substituto antes do novo Pix.",
              },
            },
          ],
          finishReason: "tool_calls",
        },
      },
      {
        match: { userMessage: "#9911", turnIndex: 4, hasToolResult: true },
        response: {
          toolCalls: [
            {
              name: "codespar_pay",
              arguments: {
                action: "pay",
                amount: 42500,
                currency: "BRL",
                method: "pix",
                description: "Pagamento via Pix do pedido #9911 (boleto vencido)",
              },
            },
          ],
          finishReason: "tool_calls",
        },
      },
      {
        match: { userMessage: "#9911", turnIndex: 5, hasToolResult: true },
        response: {
          content:
            "Tudo certo! Como a janela de correção da nota já tinha fechado, cancelei a nota antiga do pedido #9911 e emiti uma nota substituta, e gerei um Pix novo pra você concluir. Assim que o pagamento cair, seguimos com o envio. Qualquer dúvida, estou por aqui!",
          finishReason: "stop",
        },
      },
    ],
  },
};
