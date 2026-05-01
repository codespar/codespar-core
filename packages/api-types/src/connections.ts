import { z } from "zod";
import { TimestampSchema } from "./common.js";

// Server catalog declares auth_type for each provider. Kept open-ended here
// (string, not enum) so new types don't need an api-types bump to roll out.
export const AuthTypeSchema = z.string();

export const ConnectionStatusSchema = z.enum([
  "pending",
  "connected",
  "revoked",
  "expired",
]);
export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>;

// POST /v1/connections accepts either a single secret string (api_key auth)
// or an object for multi-field secrets (path_secret, oauth client creds).
//
// `connection_metadata` (added in 0.3.0) carries operator-controlled
// merchant-scoped config (NFe.io company_id, Asaas split wallet_id,
// MP marketplace_seller_id) that the agent shouldn't have to know.
// The backend persists it into `connected_accounts.connection_metadata`
// (jsonb) and merges it into upstream request bodies before transform-
// shaped fields land. See codespar-enterprise migration 0057 + Phase
// 9.9 / 9.10. Open-shape value (`unknown`) — per-server schema lives
// dashboard-side; this contract only enforces total-size guardrails.
export const CreateConnectionRequestSchema = z.object({
  server_id: z.string().min(1).max(64),
  secret: z.union([
    z.string().min(1).max(4096),
    z.record(z.string(), z.string().min(1).max(4096)),
  ]),
  display_name: z.string().min(1).max(128).optional(),
  user_id: z.string().min(1).max(128).optional(),
  connection_metadata: z.record(z.string(), z.unknown()).optional(),
});
export type CreateConnectionRequest = z.infer<
  typeof CreateConnectionRequestSchema
>;

// org_id and project_id are intentionally omitted from the wire response —
// the backend's serializeConnection() strips them. Callers already know
// their own org/project from the auth context, and leaking either across
// a poorly-scoped proxy would be a cross-tenant signal we'd rather not
// emit by default.
export const ConnectionRowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  server_id: z.string(),
  auth_type: AuthTypeSchema,
  status: ConnectionStatusSchema,
  display_name: z.string().nullable(),
  /**
   * OAuth-derived provider data (account_id, scope, …) — written by
   * the OAuth callback, not by operators. Distinct from
   * `connection_metadata` below which is operator-controlled merchant
   * config.
   */
  metadata: z.unknown(),
  /**
   * Operator-controlled merchant config (NFe.io company_id, Asaas
   * wallet_id, MP marketplace_seller_id). Added in 0.3.0. The backend
   * defaults it to `{}` when no value was set at connect time, so
   * older clients that drop the field on read see no behavioral
   * change — only newer clients can render the values.
   */
  connection_metadata: z.record(z.string(), z.unknown()).optional(),
  created_at: TimestampSchema,
  connected_at: TimestampSchema.nullable(),
  revoked_at: TimestampSchema.nullable(),
  expires_at: TimestampSchema.nullable(),
});
export type ConnectionRow = z.infer<typeof ConnectionRowSchema>;

export const ListConnectionsResponseSchema = z.object({
  connections: z.array(ConnectionRowSchema),
});
export type ListConnectionsResponse = z.infer<
  typeof ListConnectionsResponseSchema
>;

export const RotateWebhookSecretRequestSchema = z.object({
  secret: z.string().min(1).max(1024),
});
export type RotateWebhookSecretRequest = z.infer<
  typeof RotateWebhookSecretRequestSchema
>;

export const RotateWebhookSecretResponseSchema = z.object({
  connection_id: z.string(),
  server_id: z.string(),
  updated: z.boolean(),
});
export type RotateWebhookSecretResponse = z.infer<
  typeof RotateWebhookSecretResponseSchema
>;
