#!/usr/bin/env node
/**
 * Seeds one Medplum AccessPolicy per staff role (apps/web/src/lib/hospital.ts
 * ROLES) — the SERVER-SIDE enforcement of least privilege. The web app's
 * UI hiding is cosmetic; these policies are what Medplum actually checks on
 * every FHIR read/search/write.
 *
 * Idempotent: policies are matched by name ("HInS role: <code>", see
 * apps/web/src/lib/access.ts accessPolicyName) and PUT back to this exact
 * definition on every run, so re-running converges drift.
 *
 * Policy shape (verified live against Medplum 5.2.6):
 *   - A resource type that is NOT listed is denied entirely (403 on read /
 *     search / write).
 *   - `readonly: true` -> read/search/history only.
 *   - `interaction: [...]` -> exactly those FHIR interactions. Every non-admin
 *     role here omits 'delete': the platform is non-destructive (status
 *     transitions only), and the server now enforces that for staff.
 *   - `criteria` -> row-level filter (a FHIR search); reads only return
 *     matching rows and writes must produce a matching row.
 *   - `hiddenFields` -> stripped from responses.
 *
 * Known gaps, stated plainly:
 *   - No department/patient scoping yet: a lab tech sees every patient's
 *     lab orders hospital-wide, not just their department's queue. Medplum
 *     criteria could do this (e.g. compartment / %profile parameters) once
 *     ServiceRequest.performer is consistently set to the department org.
 *   - Binary has no row-level criteria (Medplum doesn't support it), so a
 *     role with Binary access can fetch any Binary whose id it knows. Clinical
 *     notes in this app store text inline in DocumentReference (not Binary),
 *     which limits the practical exposure today.
 *   - Lab/radiology DocumentReference access depends on documents carrying
 *     category DOC_CATEGORY_SYSTEM|lab-report / |imaging-report. A report
 *     written without that category is invisible to (and unwritable by) them.
 *   - Break-the-glass / emergency override is not modelled.
 *   - dr.sharma keeps Medplum's "Default Practitioner Access Policy" (broad:
 *     read everything, write most). The new "physician" policy is narrower
 *     and applies to physicians invited from now on.
 *
 * Usage: node scripts/seed/seed-access-policies.mjs
 */
import { adminLogin, must, request } from './_medplum-client.mjs';

// Must match apps/web/src/lib/access.ts
const POLICY_PREFIX = 'HInS role: ';
const DOC_CATEGORY_SYSTEM = 'https://hins.example/fhir/document-category';

const NO_DELETE = ['read', 'vread', 'search', 'history', 'create', 'update'];
const READ_UPDATE = ['read', 'vread', 'search', 'history', 'update'];

const rw = (resourceType, extra = {}) => ({ resourceType, interaction: NO_DELETE, ...extra });
const ro = (resourceType, extra = {}) => ({ resourceType, readonly: true, ...extra });
const readUpdate = (resourceType, extra = {}) => ({ resourceType, interaction: READ_UPDATE, ...extra });

/** Every staff member can see the org chart (who works where) — read-only. */
const DIRECTORY = ['Practitioner', 'PractitionerRole', 'Organization', 'Location', 'HealthcareService'].map((t) => ro(t));

const CLINICAL_CORE = [
  'Patient', 'Encounter', 'Condition', 'Observation', 'DocumentReference', 'Binary', 'Media',
  'AllergyIntolerance', 'Procedure', 'CarePlan', 'CareTeam', 'Goal', 'Immunization',
  'ClinicalImpression', 'Composition', 'Communication', 'CommunicationRequest', 'Task', 'Flag',
  'FamilyMemberHistory', 'QuestionnaireResponse', 'Provenance', 'RiskAssessment', 'DetectedIssue',
  'EpisodeOfCare', 'Appointment', 'MedicationStatement', 'NutritionOrder',
];
const CLINICAL_READ = [
  'Specimen', 'ImagingStudy', 'MedicationDispense', 'Medication', 'Coverage', 'Questionnaire',
  'Schedule', 'Slot', 'Consent',
];

const labDocs = { criteria: `DocumentReference?category=${DOC_CATEGORY_SYSTEM}|lab-report` };
const imagingDocs = { criteria: `DocumentReference?category=${DOC_CATEGORY_SYSTEM}|imaging-report` };

/** Billing sees who the patient is and how to bill them — not their chart. */
const PATIENT_BILLING_VIEW = ro('Patient', { hiddenFields: ['photo', 'contact', 'generalPractitioner', 'link'] });
const ENCOUNTER_BILLING_VIEW = ro('Encounter', { hiddenFields: ['reasonCode', 'reasonReference', 'diagnosis', 'hospitalization'] });

const POLICIES = {
  physician: [
    ...CLINICAL_CORE.map((t) => rw(t)),
    rw('MedicationRequest'),
    rw('ServiceRequest'),
    rw('DiagnosticReport'),
    ...CLINICAL_READ.map((t) => ro(t)),
    ro('MedicationAdministration'),
  ],
  nurse: [
    ...CLINICAL_CORE.map((t) => rw(t)),
    ro('MedicationRequest'),
    ro('ServiceRequest'),
    ro('DiagnosticReport'),
    rw('MedicationAdministration'),
    ...CLINICAL_READ.map((t) => ro(t)),
  ],
  'triage-nurse': [
    rw('Patient'), rw('Encounter'), rw('Observation'), rw('AllergyIntolerance'), rw('Flag'), rw('Task'),
    rw('DocumentReference'), rw('Binary'),
    ro('Condition'), ro('MedicationRequest'), ro('Appointment'), ro('Coverage'),
  ],
  'lab-technician': [
    ro('Patient'),
    readUpdate('ServiceRequest'),
    rw('Specimen'), rw('Observation'), rw('DiagnosticReport'), rw('Binary'), rw('Task'),
    rw('DocumentReference', labDocs),
    ro('SpecimenDefinition'), ro('ObservationDefinition'),
  ],
  pathologist: [
    ro('Patient'),
    readUpdate('ServiceRequest'),
    rw('Specimen'), rw('Observation'), rw('DiagnosticReport'), rw('Binary'), rw('Task'),
    rw('DocumentReference', labDocs),
    ro('SpecimenDefinition'), ro('ObservationDefinition'),
  ],
  'radiology-technician': [
    ro('Patient'),
    readUpdate('ServiceRequest'),
    rw('ImagingStudy'), rw('Media'), rw('Binary'), rw('Task'),
    rw('DocumentReference', imagingDocs),
    ro('DiagnosticReport'),
  ],
  radiologist: [
    ro('Patient'),
    readUpdate('ServiceRequest'),
    rw('ImagingStudy'), rw('Media'), rw('Binary'), rw('Task'), rw('DiagnosticReport'), rw('Observation'),
    rw('DocumentReference', imagingDocs),
  ],
  pharmacist: [
    ro('Patient'),
    ro('MedicationRequest'),
    rw('MedicationDispense'), rw('MedicationAdministration'), rw('Medication'), rw('Task'),
    ro('AllergyIntolerance'), // dispensing safety check — read-only
  ],
  dietitian: [
    ro('Patient'),
    rw('NutritionOrder'),
    ro('AllergyIntolerance'),
    ro('Encounter'),
    ro('Observation', { criteria: 'Observation?category=vital-signs' }), // weight/height only, not labs
  ],
  'billing-staff': [
    PATIENT_BILLING_VIEW,
    ENCOUNTER_BILLING_VIEW,
    ...['Coverage', 'Account', 'ChargeItem', 'Claim', 'ClaimResponse', 'Invoice', 'PaymentReconciliation',
      'PaymentNotice', 'ExplanationOfBenefit', 'CoverageEligibilityRequest', 'CoverageEligibilityResponse',
      'Organization'].map((t) => rw(t)),
    ro('ChargeItemDefinition'), ro('InsurancePlan'),
  ],
  'front-desk': [
    rw('Patient'), rw('Appointment'), rw('Coverage'), rw('RelatedPerson'), rw('Slot'),
    ro('Schedule'), ro('Encounter', { hiddenFields: ['reasonCode', 'reasonReference', 'diagnosis'] }),
  ],
  // Everything, including delete and project-admin resources. Project-admin
  // APIs (invite, membership edits) additionally need ProjectMembership.admin
  // = true, which seed-staff.mjs / StaffAdmin set for this role.
  'hospital-admin': [{ resourceType: '*' }],
};

/** Merge DIRECTORY with role entries; a role's own entry for a type wins. */
function buildResources(entries) {
  const byType = new Map();
  for (const e of DIRECTORY) byType.set(e.resourceType, e);
  for (const e of entries) byType.set(e.resourceType, e);
  return [...byType.values()];
}

const token = await adminLogin();
for (const [role, entries] of Object.entries(POLICIES)) {
  const name = `${POLICY_PREFIX}${role}`;
  const resource = role === 'hospital-admin' ? entries : buildResources(entries);
  const found = await must(`/fhir/R4/AccessPolicy?name=${encodeURIComponent(name)}`, { token });
  const existing = (found.entry ?? []).map((e) => e.resource).find((p) => p.name === name);
  const body = { resourceType: 'AccessPolicy', name, resource };
  if (existing) {
    const r = await request(`/fhir/R4/AccessPolicy/${existing.id}`, { method: 'PUT', token, body: { ...body, id: existing.id } });
    if (!r.ok) throw new Error(`update ${name}: ${r.status} ${JSON.stringify(r.json)}`);
    console.log(`  synced:  ${name} (AccessPolicy/${existing.id}, ${resource.length} rules)`);
  } else {
    const created = await must('/fhir/R4/AccessPolicy', { method: 'POST', token, body });
    console.log(`  created: ${name} (AccessPolicy/${created.id}, ${resource.length} rules)`);
  }
}
console.log('Done.');
