/**
 * Consent record types — docs/PLATFORM_BLUEPRINT.md §04.1.
 *
 * The Consent Service (services/consent-service) is the only writer of these
 * records. Every event is append-only: a revoke creates a new record with
 * status "revoked", it never mutates the original grant in place, so the
 * full consent history stays reconstructable for an ABDM or HIPAA audit.
 */

/** Which of the four regulatory consent concepts this record satisfies. */
export type ConsentType =
  | 'data_sharing' // ABDM — per-HIP consent artefact
  | 'treatment_authorization' // HIPAA — treatment / payment / operations
  | 'research' // ICMR — informed consent for a study
  | 'recording' // Voice/video capture during an encounter (§08.1)
  | 'marketing';

/** 'pending' = a clinician-initiated request awaiting the patient's own
 * approve/deny decision (§04.2/§16 "Consent approval round trip"); a
 * denied request reuses 'revoked' rather than a separate terminal value —
 * see services/consent-service/src/db/schema.ts for the reasoning. */
export type ConsentStatus = 'granted' | 'revoked' | 'expired' | 'pending';

/** DPDP/ABDM purpose binding — a request must declare one of these. */
export type ConsentPurpose = 'self_use' | 'treatment' | 'payment' | 'research';

/** A patient, or their legally authorized representative (guardian, for a minor or a person with disabilities). */
export interface ConsentGrantor {
  /** FHIR Patient.id */
  patientId: string;
  /** Present only when the grantor is a guardian/LAR acting for the patient. */
  representative?: {
    /** FHIR RelatedPerson.id or Practitioner.id, depending on who's acting */
    personId: string;
    relationship: string;
  };
}

/** The system or party asking for access — an ABDM HIU, a research study, a billing processor, etc. */
export interface ConsentRequester {
  id: string;
  displayName: string;
  /** e.g. an ABDM HIU facility ID, or an internal study ID for research consent */
  externalRef?: string;
}

export interface ConsentRecord {
  consentId: string;
  type: ConsentType;
  grantor: ConsentGrantor;
  /** Health information types in scope — never "all". e.g. ["OPDRecord", "LabReport", "Prescription"] */
  scope: string[];
  purposeCode: ConsentPurpose;
  requester: ConsentRequester;
  validity: {
    start: string; // ISO 8601
    expiry: string; // ISO 8601 — no indefinite grants
  };
  status: ConsentStatus;
  /** Cryptographic signature over the artefact — required for ABDM HIP/HIU exchange, recommended for all types. */
  signature?: string;
  /** Set only on a revoke record; points back at the consentId it supersedes. */
  revokes?: string;
  createdAt: string; // ISO 8601
}

/** Per-recipient propagation tracking for a revoke — docs §04.3, risk register §15. */
export interface RevocationPropagationStatus {
  consentId: string;
  recipientId: string; // the HIP/HIU that received data under the original grant
  status: 'pending' | 'confirmed' | 'failed';
  attemptedAt: string;
  confirmedAt?: string;
}
