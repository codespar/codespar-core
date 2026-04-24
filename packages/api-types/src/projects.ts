import { z } from "zod";
import { EnvironmentSchema, TimestampSchema } from "./common.js";

const ProjectSlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_-]+$/);

export const CreateProjectRequestSchema = z.object({
  name: z.string().min(1).max(128),
  slug: ProjectSlugSchema.refine((s) => s !== "default", {
    message: "slug 'default' is reserved",
  }),
  environment: EnvironmentSchema.optional(),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

export const UpdateProjectRequestSchema = z
  .object({
    name: z.string().min(1).max(128).optional(),
    slug: ProjectSlugSchema.optional(),
    is_default: z.literal(true).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "empty_patch" });
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequestSchema>;

export const ProjectRowSchema = z.object({
  id: z.string(),
  org_id: z.string(),
  name: z.string(),
  slug: z.string(),
  is_default: z.boolean(),
  environment: EnvironmentSchema,
  created_at: TimestampSchema,
});
export type ProjectRow = z.infer<typeof ProjectRowSchema>;

export const ListProjectsResponseSchema = z.object({
  projects: z.array(ProjectRowSchema),
});
export type ListProjectsResponse = z.infer<typeof ListProjectsResponseSchema>;
