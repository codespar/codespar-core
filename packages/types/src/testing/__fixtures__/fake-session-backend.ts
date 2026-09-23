/**
 * Fixtures shared by the fake-backend harnesses of the session contract
 * suite and the meta-tool conformance kit: the 201 body a conforming
 * runtime returns for session-create, a JSON `Response` builder, and the
 * session-create branch both `fetch` stubs route through.
 */

/** A session-create answer: JSON body plus HTTP status (201 when omitted). */
export interface FakeCreate {
  status?: number;
  body: unknown;
}

/** The 201 body a conforming runtime returns for `{ servers: [], user_id }`. */
export function createdOk(userId: string): FakeCreate {
  return {
    status: 201,
    body: {
      id: "ses_fake",
      status: "active",
      user_id: userId,
      servers: [] as string[],
      created_at: "2026-09-23T12:00:00.000Z",
    },
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** True for the `POST /v1/sessions` request a `fetch` stub should answer with a create body. */
export function isSessionCreate(url: string | URL, init?: RequestInit): boolean {
  return String(url).endsWith("/v1/sessions") && init?.method === "POST";
}

/** True for the `DELETE /v1/sessions/:id` request that closes a session. */
export function isSessionDelete(url: string | URL, init?: RequestInit): boolean {
  return /\/v1\/sessions\/[^/]+$/.test(String(url)) && init?.method === "DELETE";
}
