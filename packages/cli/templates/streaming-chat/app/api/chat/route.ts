import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";
import { CodeSpar } from "@codespar/sdk";
import { getTools } from "@codespar/vercel";

const codespar = new CodeSpar({ apiKey: process.env.CODESPAR_API_KEY! });

export async function POST(req: Request) {
  const { messages } = await req.json();

  const session = await codespar.create("cli-user", {
    servers: ["stripe", "asaas", "correios"],
  });

  const tools = await getTools(session);

  const result = streamText({
    model: openai("gpt-4o"),
    tools,
    maxSteps: 10,
    system: "Commerce assistant for a Brazilian store. Be concise and respond in Portuguese when asked.",
    messages,
    onFinish: async () => {
      await session.close();
    },
  });

  return result.toDataStreamResponse();
}
