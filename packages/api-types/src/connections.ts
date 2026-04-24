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
export const CreateConnectionRequestSchema = z.object({
  server_id: z.string().min(1).max(64),
  secret: z.union([
    z.string().min(1).max(4096),
    z.record(z.string(), z.string().min(1).max(4096)),
  ]),
  display_name: z.string().min(1).max(128).optional(),
  user_id: z.string().min(1).max(128).optional(),
});
export type CreateConnectionRequest = z.infer<
  typeof CreateConnectionRequestSchema
>;

export const ConnectionRowSchema = z.object({
  id: z.string(),
  org_id: z.string(),
  project_id: z.string().nullable(),
  user_id: z.string(),
  server_id: z.string(),
  auth_type: AuthTypeSchema,
  status: ConnectionStatusSchema,
  display_name: z.string().nullable(),
  metadata: z.unknown(),
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
