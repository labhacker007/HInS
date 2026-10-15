/**
 * Thin client for the Consent Service (services/consent-service) —
 * docs/PLATFORM_BLUEPRINT.md §04.
 *
 * ConsentApiRecord intentionally does NOT reuse @hins/shared's nested
 * ConsentRecord type: the service's actual wire shape (its Drizzle row,
 * serialized by ConsentRecordResponseSchema in
 * services/consent-service/src/schemas.ts) is flat --
 * grantorPatientId/validityStart/validityExpiry, not grantor.patientId /
 * validity.start. @hins/shared's nested shape is the aspirational domain
 * model; this is what's actually on the wire today. Keep this type in sync
 * with ConsentRecordResponseSchema if that changes.
 */
import type { ConsentPurpose, ConsentType } from '@hins/shared';

export interface ConsentApiRecord {
  consentId: string;
  type: ConsentType;
  grantorPatientId: string;
  grantorRepresentativePersonId: string | null;
  grantorRepresentativeRelationship: string | null;
  scope: string[];
  purposeCode: ConsentPurpose;
  requesterId: string;
  requesterDisplayName: string;
  requesterExternalRef: string | null;
  validityStart: string;
  validityExpiry: string;
  status: 'granted' | 'revoked' | 'expired';
  signature: string | null;
  revokes: string | null;
  createdAt: string;
}

const BASE_URL = import.meta.env.VITE_CONSENT_SERVICE_URL;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? `Consent Service error: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export interface CreateConsentInput {
  type: ConsentType;
  grantorPatientId: string;
  scope: string[];
  purposeCode: ConsentPurpose;
  requesterId: string;
  requesterDisplayName: string;
  validityStart: string;
  validityExpiry: string;
}

export function listActiveConsents(patientId: string): Promise<ConsentApiRecord[]> {
  return request(`/consents?patientId=${encodeURIComponent(patientId)}`);
}

export function createConsent(input: CreateConsentInput): Promise<ConsentApiRecord> {
  return request('/consents', {
    method: 'POST',
    body: JSON.stringify({
      type: input.type,
      grantor: { patientId: input.grantorPatientId },
      scope: input.scope,
      purposeCode: input.purposeCode,
      requester: { id: input.requesterId, displayName: input.requesterDisplayName },
      validity: { start: input.validityStart, expiry: input.validityExpiry },
    }),
  });
}

export function revokeConsent(consentId: string, recipients: string[] = []): Promise<ConsentApiRecord> {
  return request(`/consents/${consentId}/revoke`, {
    method: 'POST',
    body: JSON.stringify({ recipients }),
  });
}
