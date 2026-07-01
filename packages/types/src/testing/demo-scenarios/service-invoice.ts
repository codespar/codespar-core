import type { DemoScenario } from "../demo-scenario.js";

/* Service-invoice demo, expressed at the meta-tool abstraction.
 *
 * One natural-language request issues two fiscal documents and sends the links
 * back over WhatsApp. The agent calls `codespar_invoice` twice then
 * `codespar_notify` once — never a raw `serverId__tool`. Consume it by
 * importing `SERVICE_INVOICE_SCENARIO`: a consumer boots a runtime and serves
 * `aimockFixtures` at its canned-LLM endpoint.
 *
 * `mocks` is keyed on the meta-tool name so the fixture is returned regardless
 * of how a runtime routes the meta-tool to underlying tools — which validates
 * that meta-tool-level mock interception holds.
 */
export const SERVICE_INVOICE_SCENARIO: DemoScenario = {
  name: "service-invoice",
  servers: ["nuvem-fiscal", "z-api"],
  mocks: {
    // codespar_invoice is called twice; a stateful array returns one per call.
    codespar_invoice: [
      { id: "nfse_demo_001", status: "autorizada", pdf_url: "https://example.test/nfse_demo_001.pdf" },
      { id: "nfse_demo_002", status: "autorizada", pdf_url: "https://example.test/nfse_demo_002.pdf" },
    ],
    codespar_notify: { messageId: "msg_demo_001", sent: true },
  },
  turns: [
    {
      message:
        "Preciso de duas NFS-e: taxa de acesso à plataforma R$2.800 e consultoria de onboarding R$1.200. Envia os PDFs no WhatsApp +5511987654321.",
      expectMetaTools: ["codespar_invoice", "codespar_notify"],
    },
  ],
  aimockFixtures: {
    fixtures: [
      {
        match: { userMessage: "NFS-e", turnIndex: 0, hasToolResult: false },
        response: {
          toolCalls: [
            {
              name: "codespar_invoice",
              arguments: {
                type: "nfse",
                recipient: { name: "Cliente Demo", document: "00000000000" },
                items: [{ description: "Plataforma SaaS - acesso mensal", amount: 2800.0 }],
              },
            },
            {
              name: "codespar_invoice",
              arguments: {
                type: "nfse",
                recipient: { name: "Cliente Demo", document: "00000000000" },
                items: [{ description: "Consultoria de onboarding", amount: 1200.0 }],
              },
            },
          ],
          finishReason: "tool_calls",
        },
      },
      {
        match: { userMessage: "NFS-e", turnIndex: 1, hasToolResult: true },
        response: {
          toolCalls: [
            {
              name: "codespar_notify",
              arguments: {
                channel: "whatsapp",
                to: "+5511987654321",
                message:
                  "Suas notas estão prontas: https://example.test/nfse_demo_001.pdf https://example.test/nfse_demo_002.pdf",
              },
            },
          ],
          finishReason: "tool_calls",
        },
      },
      {
        match: { userMessage: "NFS-e", turnIndex: 2, hasToolResult: true },
        response: {
          content:
            "Duas NFS-e emitidas (nfse_demo_001 e nfse_demo_002) e os PDFs enviados no WhatsApp.",
          finishReason: "stop",
        },
      },
    ],
  },
};
