import { z } from "zod";

// Fastify serializes JS Date to ISO-8601 strings in JSON responses. Every
// timestamp field on the wire is therefore a string, not a Date.
export const TimestampSchema = z.string().datetime({ offset: true });

export const EnvironmentSchema = z.enum(["live", "test"]);
export type Environment = z.infer<typeof EnvironmentSchema>;

export const ProjectIdSchema = z.string().regex(/^prj_[A-Za-z0-9]{16}$/);

export const ErrorResponseSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
  issues: z.unknown().optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
