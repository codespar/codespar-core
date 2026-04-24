import { describe, expect, it } from "vitest";
import {
  ApiKeyRowSchema,
  ConnectionRowSchema,
  CreateApiKeyRequestSchema,
  CreatedApiKeySchema,
  ListApiKeysResponseSchema,
  ListProjectsResponseSchema,
  ProjectRowSchema,
  ServerAuthSchemaResponseSchema,
  ServerRowSchema,
  SessionRowSchema,
} from "./index.js";

describe("api-keys", () => {
  it("accepts a POST create request", () => {
    expect(
      CreateApiKeyRequestSchema.parse({ name: "my key", env: "test" }),
    ).toEqual({ name: "my key", env: "test" });
  });

  it("rejects CreatedApiKey missing full_key", () => {
    const res = CreatedApiKeySchema.safeParse({
      id: "k_1",
      name: "x",
      prefix: "csk_test_abc",
      created_at: "2026-04-24T12:00:00.000Z",
      revoked_at: null,
      last_used_at: null,
    });
    expect(res.success).toBe(false);
  });

  it("rejects CreatedApiKey with non-null revoked_at (regression: web-#155)", () => {
    const res = CreatedApiKeySchema.safeParse({
      id: "k_1",
      name: "x",
      prefix: "csk_test_abc",
      full_key: "csk_test_abcdef",
      created_at: "2026-04-24T12:00:00.000Z",
      revoked_at: "2026-04-24T12:00:00.000Z",
      last_used_at: null,
    });
    expect(res.success).toBe(false);
  });

  it("accepts list response with keys[] (regression: web-#156 parsed api_keys)", () => {
    const res = ListApiKeysResponseSchema.parse({
      keys: [
        {
          id: "k_1",
          name: "x",
          prefix: "csk_test_abc",
          created_at: "2026-04-24T12:00:00.000Z",
          last_used_at: null,
          revoked_at: null,
        },
      ],
    });
    expect(res.keys).toHaveLength(1);
  });

  it("rejects list response shaped as api_keys[]", () => {
    const res = ListApiKeysResponseSchema.safeParse({
      api_keys: [],
    });
    expect(res.success).toBe(false);
  });

  it("accepts ApiKeyRow with nullable last_used_at", () => {
    expect(
      ApiKeyRowSchema.parse({
        id: "k_1",
        name: "x",
        prefix: "csk_test_abc",
        created_at: "2026-04-24T12:00:00.000Z",
        last_used_at: null,
        revoked_at: null,
      }),
    ).toBeTruthy();
  });
});

describe("projects", () => {
  it("accepts a ProjectRow", () => {
    expect(
      ProjectRowSchema.parse({
        id: "prj_abcdef0123456789",
        org_id: "org_123",
        name: "dev",
        slug: "dev",
        is_default: true,
        environment: "test",
        created_at: "2026-04-24T12:00:00.000Z",
      }),
    ).toBeTruthy();
  });

  it("rejects ProjectRow with bad environment", () => {
    const res = ProjectRowSchema.safeParse({
      id: "prj_abcdef0123456789",
      org_id: "org_123",
      name: "dev",
      slug: "dev",
      is_default: true,
      environment: "staging",
      created_at: "2026-04-24T12:00:00.000Z",
    });
    expect(res.success).toBe(false);
  });

  it("parses list shape", () => {
    const res = ListProjectsResponseSchema.parse({ projects: [] });
    expect(res.projects).toEqual([]);
  });
});

describe("connections", () => {
  it("accepts a connected ConnectionRow (no org_id / project_id — the backend strips them)", () => {
    expect(
      ConnectionRowSchema.parse({
        id: "ca_abc",
        user_id: "dashboard",
        server_id: "asaas",
        auth_type: "api_key",
        status: "connected",
        display_name: null,
        metadata: {},
        created_at: "2026-04-24T12:00:00.000Z",
        connected_at: "2026-04-24T12:00:00.000Z",
        revoked_at: null,
        expires_at: null,
      }),
    ).toBeTruthy();
  });

  it("rejects ConnectionRow with unknown status", () => {
    const res = ConnectionRowSchema.safeParse({
      id: "ca_abc",
      user_id: "x",
      server_id: "asaas",
      auth_type: "api_key",
      status: "pending_user_action",
      display_name: null,
      metadata: {},
      created_at: "2026-04-24T12:00:00.000Z",
      connected_at: null,
      revoked_at: null,
      expires_at: null,
    });
    expect(res.success).toBe(false);
  });
});

describe("servers", () => {
  it("accepts a ServerRow", () => {
    expect(
      ServerRowSchema.parse({
        id: "asaas",
        name: "Asaas",
        pkg: "@codespar/server-asaas",
        category: "payments",
        country: "BR",
        auth_type: "api_key",
        tools_count: 7,
        description: null,
        status: "production",
      }),
    ).toBeTruthy();
  });

  it("accepts auth-schema response with null oauth_authorize_url", () => {
    expect(
      ServerAuthSchemaResponseSchema.parse({
        server_id: "asaas",
        auth_type: "api_key",
        environment: "test",
        base_url: "https://api-sandbox.asaas.com/v3",
        oauth_authorize_url: null,
        fields: [
          { name: "access_token", kind: "api_key", label: "Access token" },
        ],
      }),
    ).toBeTruthy();
  });
});

describe("sessions", () => {
  it("accepts a SessionRow with closed_at omitted", () => {
    expect(
      SessionRowSchema.parse({
        id: "ses_abc",
        org_id: "org_123",
        project_id: "prj_abcdef0123456789",
        user_id: "dashboard",
        servers: ["asaas"],
        status: "active",
        created_at: "2026-04-24T12:00:00.000Z",
      }),
    ).toBeTruthy();
  });
});
