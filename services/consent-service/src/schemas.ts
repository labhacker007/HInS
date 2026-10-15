/**
 * Zod request/response schemas — validated by Fastify on every route via
 * fastify-type-provider-zod, and also the source of the OpenAPI doc Fastify
 * generates from them. Shapes mirror @hins/shared's ConsentRecord
 * (docs/PLATFORM_BLUEPRINT.md §04.1).
 */
import { z } from 'zod';

export const ConsentTypeSchema = z.enum([
  'data_sharing',
  'treatment_authorization',
  'research',
  'recording',
  'marketing',
]);

export const ConsentPurposeSchema = z.enum(['self_use', 'treatment', 'payment', 'research']);
export const ConsentStatusSchema = z.enum(['granted', 'revoked', 'expired']);

export const CreateConsentSchema = z.object({
  type: ConsentTypeSchema,
  grantor: z.object({
    patientId: z.string().min(1),
    representative: z
      .object({
        personId: z.string().min(1),
        relationship: z.string().min(1),
      })
      .optional(),
  }),
  // Never allow an empty/wildcard scope — the point of this field (§04.1).
  scope: z.array(z.string().min(1)).min(1),
  purposeCode: ConsentPurposeSchema,
  requester: z.object({
    id: z.string().min(1),
    displayName: z.string().min(1),
    externalRef: z.string().optional(),
  }),
  validity: z
    .object({
      start: z.coerce.date(),
      expiry: z.coerce.date(),
    })
    .refine((v) => v.expiry > v.start, {
      message: 'validity.expiry must be after validity.start — no indefinite grants (§04.1)',
      path: ['expiry'],
    }),
  signature: z.string().optional(),
});

export const ConsentRecordResponseSchema = z.object({
  consentId: z.uuid(),
  type: ConsentTypeSchema,
  grantorPatientId: z.string(),
  grantorRepresentativePersonId: z.string().nullable(),
  grantorRepresentativeRelationship: z.string().nullable(),
  scope: z.array(z.string()),
  purposeCode: ConsentPurposeSchema,
  requesterId: z.string(),
  requesterDisplayName: z.string(),
  requesterExternalRef: z.string().nullable(),
  validityStart: z.coerce.date(),
  validityExpiry: z.coerce.date(),
  status: ConsentStatusSchema,
  signature: z.string().nullable(),
  revokes: z.uuid().nullable(),
  createdAt: z.coerce.date(),
});

export const RevokeConsentSchema = z.object({
  // HIPs/HIUs that received data under the grant being revoked — seeds
  // revocation_propagation rows tracked per §04.3.
  recipients: z.array(z.string().min(1)).default([]),
});

export const ListConsentsQuerySchema = z.object({
  patientId: z.string().min(1),
});

export const ErrorResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
});
