import { z } from 'zod';

export const RecordEventSchema = z.object({
  resourceType: z.string().min(1),
  resourceId: z.string().min(1),
  patientId: z.string().min(1),
  action: z.enum(['create', 'update']),
  actorId: z.string().min(1),
  actorName: z.string().min(1),
  summary: z.string().min(1),
  /** The resource's author/requester before this edit — if different from
   * actorId, they get notified directly even if not on the static
   * alert_subscriptions list. Omit for a self-edit or on create. */
  originalAuthorId: z.string().optional(),
  originalAuthorName: z.string().optional(),
});

export const MarkReadSchema = z.object({});

export const CreateSubscriptionSchema = z.object({
  practitionerId: z.string().min(1),
  practitionerName: z.string().min(1),
  role: z.string().min(1),
});

/** Shared shape for the 401/403 responses the caller-auth check returns
 * on GET/POST /subscriptions and GET /notifications. */
export const ErrorResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
});
