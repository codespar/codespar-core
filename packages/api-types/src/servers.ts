import { z } from "zod";
import { EnvironmentSchema } from "./common.js";
import { AuthTypeSchema } from "./connections.js";

export const ServerRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  pkg: z.string(),
  category: z.string(),
  country: z.string(),
  auth_type: AuthTypeSchema,
  tools_count: z.number().int().nonnegative(),
  description: z.string().nullable(),
  status: z.string(),
});
export type ServerRow = z.infer<typeof ServerRowSchema>;

export const ListServersResponseSchema = z.object({
  total: z.number().int().nonnegative(),
  filtered: z.number().int().nonnegative(),
  servers: z.array(ServerRowSchema),
});
export type ListServersResponse = z.infer<typeof ListServersResponseSchema>;

export const AuthSchemaFieldKindSchema = z.enum([
  "api_key",
  "path_secret",
  "header",
]);
export type AuthSchemaFieldKind = z.infer<typeof AuthSchemaFieldKindSchema>;

export const AuthSchemaFieldSchema = z.object({
  name: z.string(),
  kind: AuthSchemaFieldKindSchema,
  label: z.string(),
  header_name: z.string().optional(),
});
export type AuthSchemaField = z.infer<typeof AuthSchemaFieldSchema>;

export const ServerAuthSchemaResponseSchema = z.object({
  server_id: z.string(),
  auth_type: z.enum(["api_key", "path_secret", "oauth", "cert", "none"]),
  environment: EnvironmentSchema,
  base_url: z.string(),
  oauth_authorize_url: z.string().nullable(),
  fields: z.array(AuthSchemaFieldSchema),
});
export type ServerAuthSchemaResponse = z.infer<
  typeof ServerAuthSchemaResponseSchema
>;
