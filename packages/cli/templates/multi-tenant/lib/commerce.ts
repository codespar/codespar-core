import { CodeSpar } from "@codespar/sdk";

const codespar = new CodeSpar({ apiKey: process.env.CODESPAR_API_KEY! });

export interface TenantConfig {
  id: string;
  servers: string[];
  metadata?: Record<string, string>;
}

/**
 * Wraps sessions.create() to inject tenant_id metadata on every session,
 * so tool-call logs are automatically attributable per tenant — no extra
 * code needed at call sites.
 */
export async function createTenantSession(tenant: TenantConfig) {
  return codespar.create(tenant.id, {
    servers: tenant.servers,
    metadata: {
      tenant_id: tenant.id,
      ...(tenant.metadata ?? {}),
    },
  });
}
