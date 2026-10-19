/**
 * Server-side RBAC conventions shared by the app and the seed scripts.
 *
 * Each staff role (hospital.ts ROLES) has one Medplum AccessPolicy named
 * `${ACCESS_POLICY_PREFIX}${role}` (scripts/seed/seed-access-policies.mjs).
 * A staff member's ProjectMembership.accessPolicy points at their role's
 * policy; Medplum enforces it on every FHIR call. The UI only mirrors it.
 *
 * Documents that non-clinical roles may read/write (lab and imaging
 * reports) MUST carry a category from DOC_CATEGORY_SYSTEM — the lab and
 * radiology policies filter DocumentReference by that category, so a lab
 * report saved without it is invisible to lab staff, and clinical notes
 * (no such category) stay invisible to them.
 */
import type { CodeableConcept } from '@medplum/fhirtypes';

export const ACCESS_POLICY_PREFIX = 'HInS role: ';
export const accessPolicyName = (role: string): string => `${ACCESS_POLICY_PREFIX}${role}`;
export const roleFromPolicyName = (name: string | undefined): string | undefined =>
  name?.startsWith(ACCESS_POLICY_PREFIX) ? name.slice(ACCESS_POLICY_PREFIX.length) : undefined;

export const DOC_CATEGORY_SYSTEM = 'https://hins.example/fhir/document-category';
export type DocCategory = 'lab-report' | 'imaging-report';
export const docCategory = (code: DocCategory): CodeableConcept => ({
  coding: [{ system: DOC_CATEGORY_SYSTEM, code, display: code === 'lab-report' ? 'Lab report' : 'Imaging report' }],
});

/** Roles whose membership also gets ProjectMembership.admin (needed for the invite/membership admin APIs). */
export const PROJECT_ADMIN_ROLES: readonly string[] = ['hospital-admin'];
