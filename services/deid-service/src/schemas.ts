import { z } from 'zod';

export const DeidMethodSchema = z.enum(['safe_harbor', 'limited_dataset', 'pseudonymized']);

export const ExportRequestSchema = z.object({
  patientIds: z.array(z.string().min(1)).min(1).max(100),
  method: DeidMethodSchema,
  purpose: z.string().min(1),
  requesterId: z.string().min(1),
  requesterDisplayName: z.string().min(1),
  /** Which clinical resource types to include alongside Patient. DocumentReference
   * is never included regardless of this list — see deidentify.ts's header. */
  includeResourceTypes: z
    .array(z.enum(['Condition', 'Observation', 'MedicationRequest', 'Encounter']))
    .default(['Condition', 'Observation', 'MedicationRequest']),
});

export const ReidentifyRequestSchema = z.object({
  pseudonymId: z.string().min(1),
  requesterId: z.string().min(1),
  requesterDisplayName: z.string().min(1),
  justification: z.string().min(1, 'Re-identification requires a stated justification — this is logged.'),
});

export const ErrorResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
});
