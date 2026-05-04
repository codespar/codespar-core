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
  /* Provider metadata sourced from each mcp-brasil package's server.json.
   * Optional + nullable — packages predating the 0030 migration return
   * undefined; rows where the seed never ran return null. UI falls back
   * to a Google-favicon URL constructed from `pkg` when both are absent.
   * Migration: 0030_servers_provider_metadata. */
  provider_homepage: z.string().nullable().optional(),
  provider_logo_url: z.string().nullable().optional(),
  provider_logo_fallback_url: z.string().nullable().optional(),
  provider_docs_url: z.string().nullable().optional(),
  sandbox_available: z.boolean().optional(),
  sandbox_url: z.string().nullable().optional(),
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
  // mTLS cert component (cert / key / ca PEM blob). The dashboard
  // renders a file input (accepts .pem / .crt / .key) per field; the
  // backend stores the uploaded text under the catalog-declared vault
  // ref. Used by BR open-banking + corporate APIs (BB, Itaú, Santander,
  // Bradesco, Caixa).
  "cert",
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
  auth_type: z.enum([
    "api_key",
    "path_secret",
    "oauth",
    "cert",
    "hmac_signed",
    "none",
  ]),
  environment: EnvironmentSchema,
  base_url: z.string(),
  oauth_authorize_url: z.string().nullable(),
  fields: z.array(AuthSchemaFieldSchema),
});
export type ServerAuthSchemaResponse = z.infer<
  typeof ServerAuthSchemaResponseSchema
>;
