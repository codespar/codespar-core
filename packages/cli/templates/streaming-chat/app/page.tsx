"use client";

import { useChat } from "@ai-sdk/react";

export default function Chat() {
  const { messages, input, handleInputChange, handleSubmit } = useChat({ api: "/api/chat" });

  return (
    <main style={{ maxWidth: 720, margin: "40px auto", fontFamily: "system-ui", padding: "0 20px" }}>
      <h1 style={{ fontSize: 24, marginBottom: 24 }}>{{name}}</h1>

      <div style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 400 }}>
        {messages.map((m) => (
          <div
            key={m.id}
            style={{
              padding: "10px 14px",
              borderRadius: 8,
              background: m.role === "user" ? "#EFF6FF" : "#F4F4F5",
              alignSelf: m.role === "user" ? "flex-end" : "flex-start",
              maxWidth: "80%",
            }}
          >
            {m.content}
            {m.toolInvocations?.map((tool) => (
              <div key={tool.toolCallId} style={{ marginTop: 6, fontSize: 12, color: "#6B7280" }}>
                {tool.state === "result"
                  ? `✓ ${tool.toolName} completed`
                  : `⏳ Calling ${tool.toolName}...`}
              </div>
            ))}
          </div>
        ))}
      </div>

      <form onSubmit={handleSubmit} style={{ marginTop: 24, display: "flex", gap: 8 }}>
        <input
          value={input}
          onChange={handleInputChange}
          placeholder="Ask about payments, shipping, invoices..."
          style={{
            flex: 1,
            padding: "10px 14px",
            borderRadius: 8,
            border: "1px solid #E5E7EB",
            fontSize: 14,
          }}
        />
        <button
          type="submit"
          style={{
            padding: "10px 18px",
            borderRadius: 8,
            background: "#3B82F6",
            color: "white",
            border: "none",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Send
        </button>
      </form>
    </main>
  );
}
