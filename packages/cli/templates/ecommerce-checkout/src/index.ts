/**
 * {{name}} — End-to-end e-commerce checkout agent.
 *
 * Full Complete Loop: checkout → invoice → ship → notify, in one
 * conversation, powered by Claude.
 */
import Anthropic from "@anthropic-ai/sdk";
import { CodeSpar } from "@codespar/sdk";
import { getTools, handleToolUse, toToolResultBlock } from "@codespar/claude";

const claude = new Anthropic();
const codespar = new CodeSpar({ apiKey: process.env.CODESPAR_API_KEY });

export async function checkoutAgent(userMessage: string): Promise<string> {
  const session = await codespar.create("cli-user", {
    servers: ["stripe", "nuvem-fiscal", "correios"],
  });

  try {
    const tools = await getTools(session);

    const messages: Anthropic.MessageParam[] = [{ role: "user", content: userMessage }];

    let response = await claude.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 4096,
      system: `You are a commerce assistant for a Brazilian e-commerce store.

Products:
- Pro Plan: R$49.90/month
- Enterprise Plan: R$199.90/month
- Starter Kit: R$149.00 (one-time)

Flow: confirm → checkout → invoice → ship → notify. Respond in Portuguese.`,
      tools,
      messages,
    });

    let iterations = 0;
    while (response.stop_reason === "tool_use" && iterations < 10) {
      const toolBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );

      const resultBlocks = [];
      for (const block of toolBlocks) {
        const result = await handleToolUse(session, block);
        resultBlocks.push(toToolResultBlock(block.id, result));
      }

      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: resultBlocks });

      response = await claude.messages.create({
        model: "claude-opus-4-6",
        max_tokens: 4096,
        tools,
        messages,
      });
      iterations += 1;
    }

    const text = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    return text?.text ?? "";
  } finally {
    await session.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const reply = await checkoutAgent("Quero comprar o Starter Kit. Meu CEP é 01310-100.");
  console.log(reply);
}
