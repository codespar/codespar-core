import { z } from "zod";
import { EnvironmentSchema, TimestampSchema } from "./common.js";

export const CreateApiKeyRequestSchema = z.object({
  name: z.string().min(1).max(128),
  env: EnvironmentSchema.optional(),
});
export type CreateApiKeyRequest = z.infer<typeof CreateApiKeyRequestSchema>;

// POST /v1/api-keys response. full_key appears ONLY on creation — never on
// list/get. revoked_at and last_used_at are always null on a freshly-created
// key (drift on these fields caused PR codespar-web#155).
export const CreatedApiKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  full_key: z.string(),
  created_at: TimestampSchema,
  revoked_at: z.null(),
  last_used_at: z.null(),
  warning: z.string().optional(),
});
export type CreatedApiKey = z.infer<typeof CreatedApiKeySchema>;

export const ApiKeyRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  created_at: TimestampSchema,
  last_used_at: TimestampSchema.nullable(),
  revoked_at: TimestampSchema.nullable(),
});
export type ApiKeyRow = z.infer<typeof ApiKeyRowSchema>;

// Backend returns { keys: [...] }. PR codespar-web#156 fixed a bug where the
// web client parsed data.api_keys instead — using this schema at the fetch
// boundary would have caught it at runtime.
export const ListApiKeysResponseSchema = z.object({
  keys: z.array(ApiKeyRowSchema),
});
export type ListApiKeysResponse = z.infer<typeof ListApiKeysResponseSchema>;
