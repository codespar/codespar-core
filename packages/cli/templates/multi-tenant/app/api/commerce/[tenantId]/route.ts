import { NextResponse } from "next/server";
import OpenAI from "openai";
import { getTools, handleToolCall } from "@codespar/openai";
import { createTenantSession } from "@/lib/commerce";

const openai = new OpenAI();

// In production, fetch tenant config from your database instead.
const TENANTS: Record<string, { servers: string[] }> = {
  tenant_acme: { servers: ["stripe", "correios", "nuvem-fiscal"] },
  tenant_loja: { servers: ["asaas", "melhor-envio", "z-api"] },
};

export async function POST(
  req: Request,
  { params }: { params: Promise<{ tenantId: string }> },
) {
  const { tenantId } = await params;
  const tenant = TENANTS[tenantId];
  if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 404 });

  const { message } = await req.json();

  const session = await createTenantSession({
    id: tenantId,
    servers: tenant.servers,
    metadata: { source: "api" },
  });

  try {
    const tools = await getTools(session);
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: `You are a commerce assistant for tenant ${tenantId}.` },
      { role: "user", content: message },
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

    return NextResponse.json({ reply: response.choices[0].message.content });
  } finally {
    await session.close();
  }
}
