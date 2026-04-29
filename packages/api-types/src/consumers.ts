import { z } from "zod";
import { TimestampSchema } from "./common.js";

/* Consumer-mandate / directed-pay surface — read-only list endpoints
 * GET /v1/consumers/funding-sources and GET /v1/consumers/consents.
 * Schema lives here so backend (codespar-enterprise) and dashboard
 * (codespar-web) parse the same wire shape. Migrations: 0040
 * (consumer_funding_sources), 0041 (consumer_consents).
 */

export const ConsumerFundingSourceRowSchema = z.object({
  id: z.string(),
  consumer_id: z.string(),
  rail: z.string(),
  currency: z.string(),
  provider: z.string(),
  display_label: z.string().nullable(),
  status: z.string(),
  created_at: TimestampSchema,
  expires_at: TimestampSchema.nullable(),
  revoked_at: TimestampSchema.nullable(),
  metadata: z.record(z.string(), z.unknown()),
});
export type ConsumerFundingSourceRow = z.infer<
  typeof ConsumerFundingSourceRowSchema
>;

export const ListConsumerFundingSourcesResponseSchema = z.object({
  funding_sources: z.array(ConsumerFundingSourceRowSchema),
});
export type ListConsumerFundingSourcesResponse = z.infer<
  typeof ListConsumerFundingSourcesResponseSchema
>;

export const ConsumerConsentRowSchema = z.object({
  id: z.string(),
  consumer_id: z.string(),
  funding_source_id: z.string().nullable(),
  agent_id: z.string().nullable(),
  kind: z.string(),
  hmac_secret_version: z.number().int().nonnegative(),
  cap_minor: z.string().nullable(),
  per_tx_cap_minor: z.string().nullable(),
  currency: z.string().nullable(),
  purpose: z.string().nullable(),
  ip_address: z.string().nullable(),
  signed_at: TimestampSchema,
  expires_at: TimestampSchema.nullable(),
  metadata: z.record(z.string(), z.unknown()),
});
export type ConsumerConsentRow = z.infer<typeof ConsumerConsentRowSchema>;

export const ListConsumerConsentsResponseSchema = z.object({
  consents: z.array(ConsumerConsentRowSchema),
});
export type ListConsumerConsentsResponse = z.infer<
  typeof ListConsumerConsentsResponseSchema
>;
