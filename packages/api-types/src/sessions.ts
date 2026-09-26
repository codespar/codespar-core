import { z } from "zod";
import { TimestampSchema } from "./common.js";

export const SessionStatusSchema = z.enum(["active", "closed", "error"]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const CreateSessionRequestSchema = z.object({
  // 0..20: the API accepts an empty list (meta-tool sessions are server-less
  // by design; enterprise sessions.ts, CreateSessionSchema). The .min(1) here
  // drifted from the served contract and refused a body the API takes.
  servers: z.array(z.string().min(1)).max(20),
  user_id: z.string().min(1).max(128).optional(),
  // The registered agent the session acts as, by handle (enterprise 0274,
  // codespar-enterprise#1688). Approvals raised in the session count for that
  // agent's reputation. Must name an active agent of the org, or the API
  // answers 422 agent_not_registered / agent_not_active.
  agent_id: z.string().min(1).max(128).optional(),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

export const SessionRowSchema = z.object({
  id: z.string(),
  org_id: z.string(),
  project_id: z.string(),
  user_id: z.string(),
  servers: z.array(z.string()),
  status: SessionStatusSchema,
  created_at: TimestampSchema,
  closed_at: TimestampSchema.nullable().optional(),
});
export type SessionRow = z.infer<typeof SessionRowSchema>;

export const SessionDetailSchema = SessionRowSchema.extend({
  tool_calls_count: z.number().int().nonnegative(),
});
export type SessionDetail = z.infer<typeof SessionDetailSchema>;

export const ListSessionsResponseSchema = z.object({
  sessions: z.array(SessionRowSchema),
  next_before: z.string().nullable(),
});
export type ListSessionsResponse = z.infer<typeof ListSessionsResponseSchema>;

export const ToolCallStatusSchema = z.enum(["running", "success", "error"]);
export type ToolCallStatus = z.infer<typeof ToolCallStatusSchema>;

export const ToolCallRowSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  server_id: z.string(),
  tool_name: z.string(),
  status: ToolCallStatusSchema,
  duration_ms: z.number().int().nonnegative().nullable(),
  error_code: z.string().nullable(),
  input: z.unknown(),
  output: z.unknown(),
  called_at: TimestampSchema,
});
export type ToolCallRow = z.infer<typeof ToolCallRowSchema>;

export const ListToolCallsResponseSchema = z.object({
  tool_calls: z.array(ToolCallRowSchema),
});
export type ListToolCallsResponse = z.infer<typeof ListToolCallsResponseSchema>;

export const ExecuteToolRequestSchema = z.object({
  tool: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
  input: z.record(z.string(), z.unknown()).optional(),
});
export type ExecuteToolRequest = z.infer<typeof ExecuteToolRequestSchema>;

export const ExecuteToolResponseSchema = z.object({
  success: z.boolean(),
  data: z.unknown(),
  error: z.string().nullable(),
  duration: z.number(),
  server: z.string(),
  tool: z.string(),
  tool_call_id: z.string(),
  called_at: TimestampSchema,
});
export type ExecuteToolResponse = z.infer<typeof ExecuteToolResponseSchema>;
