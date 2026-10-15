/**
 * Role catalog — docs/PLATFORM_BLUEPRINT.md §10.1.
 *
 * This is the illustrative role set from the blueprint, not a final
 * taxonomy — real deployments will need department- and specialty-scoped
 * variants. Keep this file and §10.1 in sync when either changes.
 */

export const ROLES = [
  'patient',
  'treating_physician',
  'consulting_physician',
  'nurse',
  'lab_technician',
  'radiologist',
  'pharmacist',
  'billing_rcm_staff',
  'hr_payroll',
  'research_analyst',
  'compliance_officer',
  'tenant_admin',
  'platform_super_admin',
] as const;

export type Role = (typeof ROLES)[number];

export interface RoleDefinition {
  role: Role;
  /** One-line description of the access scope, matching the doc's table. */
  scope: string;
  /** True if this role has no standing access to identifiable clinical data by default. */
  noDefaultClinicalAccess: boolean;
}

export const ROLE_DEFINITIONS: Record<Role, RoleDefinition> = {
  patient: {
    role: 'patient',
    scope: "Own record (read), own consent grants (grant/revoke), own appointments & billing",
    noDefaultClinicalAccess: false,
  },
  treating_physician: {
    role: 'treating_physician',
    scope: 'Full read/write on assigned patients’ charts, eRx, CDSS, voice scribe',
    noDefaultClinicalAccess: false,
  },
  consulting_physician: {
    role: 'consulting_physician',
    scope: 'Read-only, time-boxed, only patients explicitly referred to them',
    noDefaultClinicalAccess: false,
  },
  nurse: {
    role: 'nurse',
    scope: 'Ward-scoped vitals/MAR read-write; no billing; no diagnosis editing',
    noDefaultClinicalAccess: false,
  },
  lab_technician: {
    role: 'lab_technician',
    scope: 'LIS orders/results for assigned specimens only — not the full chart',
    noDefaultClinicalAccess: false,
  },
  radiologist: {
    role: 'radiologist',
    scope: 'RIS/PACS and related orders; no billing',
    noDefaultClinicalAccess: false,
  },
  pharmacist: {
    role: 'pharmacist',
    scope: 'eRx verification, logged drug-interaction overrides; no clinical notes',
    noDefaultClinicalAccess: false,
  },
  billing_rcm_staff: {
    role: 'billing_rcm_staff',
    scope: 'Claims/billing data, coded diagnoses only — no narrative clinical notes',
    noDefaultClinicalAccess: true,
  },
  hr_payroll: {
    role: 'hr_payroll',
    scope: 'ERP/HR module only — zero clinical data access',
    noDefaultClinicalAccess: true,
  },
  research_analyst: {
    role: 'research_analyst',
    scope: 'De-identified/aggregated data via the admin-approved export policy only — never identifiable PHI',
    noDefaultClinicalAccess: true,
  },
  compliance_officer: {
    role: 'compliance_officer',
    scope: 'Audit logs, consent records, breach workflow — read-only on clinical data itself',
    noDefaultClinicalAccess: true,
  },
  tenant_admin: {
    role: 'tenant_admin',
    scope: 'User/role management, module toggles, branding, AI provider config — no standing clinical access',
    noDefaultClinicalAccess: true,
  },
  platform_super_admin: {
    role: 'platform_super_admin',
    scope: 'Tenant provisioning and platform health — zero standing access to any tenant’s PHI',
    noDefaultClinicalAccess: true,
  },
};
