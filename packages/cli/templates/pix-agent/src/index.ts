/**
 * {{name}} — Pix payment agent.
 *
 * Usage:
 *   pnpm dev  (or: npm run dev)
 *   pixAgent("+5511999887766", 15000, "Pro Plan")
 */
import OpenAI from "openai";
import { CodeSpar } from "@codespar/sdk";
import { getTools, handleToolCall } from "@codespar/openai";

const openai = new OpenAI();
const codespar = new CodeSpar({ apiKey: process.env.CODESPAR_API_KEY });

export async function pixAgent(
  customerPhone: string,
  amount: number,
  description: string,
): Promise<string | null> {
  const session = await codespar.create("cli-user", { servers: ["asaas", "twilio"] });

  try {
    const tools = await getTools(session);

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      {
        role: "system",
        content: `You are a payment assistant for a Brazilian e-commerce store.
When asked to create a Pix payment:
1. Use codespar_pay to create the Pix charge on asaas
2. Use codespar_notify to send the QR code link via WhatsApp on twilio
Always confirm amount and phone before processing. Respond in Portuguese.`,
      },
      {
        role: "user",
        content: `Create Pix of R$${(amount / 100).toFixed(2)} for "${description}", send to ${customerPhone}`,
      },
    ];

    let response = await openai.chat.completions.create({ model: "gpt-4o", tools, messages });
    let iterations = 0;

    while (response.choices[0].message.tool_calls?.length && iterations < 10) {
      const msg = response.choices[0].message;
      messages.push(msg);

      for (const toolCall of msg.tool_calls) {
        const result = await handleToolCall(session, toolCall);
        messages.push({ role: "tool", tool_call_id: toolCall.id, content: JSON.stringify(result) });
      }

      response = await openai.chat.completions.create({ model: "gpt-4o", tools, messages });
      iterations += 1;
    }

    return response.choices[0].message.content;
  } finally {
    await session.close();
  }
}

// Demo run when executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const reply = await pixAgent("+5511999887766", 15000, "Pro Plan");
  console.log(reply);
}
