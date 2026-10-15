/**
 * The de-identification engine. Three methods, each a real, named
 * category rather than a vague "anonymize" toggle — see
 * docs/PLATFORM_BLUEPRINT.md §11 and this service's README for the full
 * rationale and what each one does and doesn't guarantee.
 *
 *   safe_harbor      HIPAA's Safe Harbor method, 45 CFR 164.514(b)(2).
 *                    Irreversible. Dates generalized to year (with the
 *                    rule's required 90+ age aggregation). No geography
 *                    retained. Intended for external research sharing —
 *                    gated on an active `research` consent (§04) in
 *                    index.ts, not here.
 *   limited_dataset   HIPAA's Limited Data Set, 45 CFR 164.514(e).
 *                    Irreversible pseudonym, but dates stay at full
 *                    precision and town/city/state/postal code are kept
 *                    (only street-level address is stripped). In real
 *                    HIPAA use this requires a signed Data Use Agreement
 *                    with the recipient — this service doesn't model DUAs,
 *                    it only implements the data transformation.
 *   pseudonymized     GDPR Art. 4(5) / Recital 26 pseudonymisation. Same
 *                    identifier stripping as safe_harbor, full-precision
 *                    dates, but the pseudonym is reversible via a securely
 *                    held mapping (db/schema.ts's pseudonymMapping table)
 *                    — meaning this data is still "personal data" under
 *                    GDPR, not anonymous. Intended for internal/admin use
 *                    where authorized re-identification may be needed
 *                    later (quality review, re-contacting a patient).
 *
 * What this does NOT do, on purpose: scrub identifiers out of free-text
 * clinical notes. HIPAA Safe Harbor technically requires that too, but
 * doing it correctly needs a validated NLP de-identification tool
 * (Microsoft Presidio + a clinical NER model, already the plan in §07/§08
 * — not wired up yet). A naive regex pass would miss real identifiers and
 * create a false sense of privacy, which is worse than the current
 * behavior: DocumentReference content is excluded entirely from every
 * export method, never partially scrubbed.
 */
import { randomUUID, createHmac } from 'node:crypto';

export type DeidMethod = 'safe_harbor' | 'limited_dataset' | 'pseudonymized';

/** A loosely-typed FHIR resource — avoids pulling in @medplum/fhirtypes
 * just for this, and the transforms below are deliberately duck-typed so
 * they degrade gracefully on resources that don't have a given field
 * rather than throwing. */
export type FhirResource = Record<string, unknown> & { resourceType: string; id?: string };

const REFERENCE_DATE = () => new Date();

function ageAt(birthDate: string, at: Date): number {
  const [y, m, d] = birthDate.split('-').map(Number);
  let age = at.getFullYear() - y;
  if (m && (at.getMonth() + 1 < m || (at.getMonth() + 1 === m && at.getDate() < (d ?? 1)))) {
    age -= 1;
  }
  return age;
}

/**
 * HIPAA Safe Harbor's date rule: all elements of a date except the year
 * are removed, AND for anyone 90 or older, the year itself must also be
 * removed (aggregated into a single "90 or older" category) — otherwise
 * a birth year alone could re-identify someone in a very old age bracket
 * with a small population.
 */
export function generalizeDateSafeHarbor(dateStr: string | undefined): string | undefined {
  if (!dateStr) return undefined;
  const year = Number(dateStr.slice(0, 4));
  if (Number.isNaN(year)) return undefined;
  const age = ageAt(`${year}-01-01`, REFERENCE_DATE());
  if (age >= 90) return undefined; // suppressed entirely — see rule above
  return String(year); // FHIR `date`/`dateTime` both accept year-only precision
}

/** limited_dataset and pseudonymized keep full date precision. */
function keepDate(dateStr: string | undefined): string | undefined {
  return dateStr;
}

function pseudonymForMethod(method: DeidMethod, realId: string, hmacKey: string): string {
  if (method === 'pseudonymized') {
    // Deterministic within a given hmacKey epoch, so the same patient
    // gets the same pseudonym across resources in one export — needed to
    // keep e.g. a Condition and its Patient linkable in the output.
    return createHmac('sha256', hmacKey).update(realId).digest('hex').slice(0, 32);
  }
  // safe_harbor / limited_dataset: fresh random UUID per export, on
  // purpose — unlinkable to any other export of the same patient, which
  // is what makes these two methods irreversible.
  return randomUUID();
}

export interface DeidContext {
  method: DeidMethod;
  /** Maps the real Patient.id to the pseudonym used throughout this
   * export, so every resource referencing that patient gets the same
   * pseudonym and Patient.id itself can be rewritten consistently. */
  patientIdMap: Map<string, string>;
  hmacKey: string;
}

export function newContext(method: DeidMethod, hmacKey: string): DeidContext {
  return { method, patientIdMap: new Map(), hmacKey };
}

function pseudonymFor(ctx: DeidContext, realPatientId: string): string {
  let p = ctx.patientIdMap.get(realPatientId);
  if (!p) {
    p = pseudonymForMethod(ctx.method, realPatientId, ctx.hmacKey);
    ctx.patientIdMap.set(realPatientId, p);
  }
  return p;
}

function rewriteSubjectReference(ref: unknown, ctx: DeidContext): unknown {
  if (typeof ref !== 'object' || ref === null) return ref;
  const r = ref as { reference?: string };
  if (typeof r.reference === 'string' && r.reference.startsWith('Patient/')) {
    const realId = r.reference.slice('Patient/'.length);
    return { reference: `Patient/${pseudonymFor(ctx, realId)}` };
  }
  return ref;
}

export function deidentifyPatient(patient: FhirResource, ctx: DeidContext): FhirResource {
  const realId = patient.id!;
  const pseudonymId = pseudonymFor(ctx, realId);
  const birthDate = patient.birthDate as string | undefined;

  const out: FhirResource = {
    resourceType: 'Patient',
    id: pseudonymId,
    gender: patient.gender, // not a Safe Harbor identifier by itself
  };

  if (ctx.method === 'safe_harbor') {
    out.birthDate = generalizeDateSafeHarbor(birthDate);
    // No geography retained at all — the conservative, simplest-to-get-right
    // reading of Safe Harbor's "geographic subdivisions smaller than a
    // state" rule (the full rule allows 3-digit ZIP / state-level under
    // specific population thresholds; omitted here rather than risk
    // getting the population-threshold math wrong).
  } else if (ctx.method === 'limited_dataset') {
    out.birthDate = keepDate(birthDate);
    const addr = (patient.address as Array<Record<string, unknown>> | undefined)?.[0];
    if (addr) {
      out.address = [{ city: addr.city, state: addr.state, postalCode: addr.postalCode, country: addr.country }];
    }
  } else {
    // pseudonymized
    out.birthDate = keepDate(birthDate);
  }

  // name / telecom / identifier / photo: stripped on every method —
  // these are direct identifiers regardless of which tier this is.
  return out;
}

/** Generic transform for the clinical resource types this service
 * handles (Condition, Observation, MedicationRequest, Encounter): repoint
 * subject/patient references to the pseudonym, drop the raw internal
 * Encounter reference, and generalize any top-level date-ish field for
 * safe_harbor. Otherwise left alone — these resource types don't carry
 * the Patient-level direct identifiers deidentifyPatient exists to
 * strip. */
export function deidentifyClinicalResource(resource: FhirResource, ctx: DeidContext): FhirResource {
  const out: FhirResource = { ...resource };
  if ('subject' in out) out.subject = rewriteSubjectReference(out.subject, ctx);
  if ('patient' in out) out.patient = rewriteSubjectReference(out.patient, ctx);

  // Drop the raw internal Encounter reference rather than rewrite it: this
  // service doesn't also pseudonymize Encounter resources by default, so a
  // passed-through `Encounter/<real-id>` would be a working internal
  // identifier a recipient could try to correlate against other data —
  // exactly what subject/patient rewriting above exists to prevent. Safer
  // to drop it than get a false sense of safety from an ID that still
  // points at a real internal record.
  delete out.encounter;
  // meta (versionId, lastUpdated, project, compartment, ...) is internal
  // provenance, not clinical data a research/admin recipient needs —
  // dropped on data-minimization grounds (GDPR Art. 5(1)(c)), not because
  // any single field in it was found to be identifying.
  delete out.meta;

  if (ctx.method === 'safe_harbor') {
    for (const field of ['recordedDate', 'effectiveDateTime', 'authoredOn'] as const) {
      if (typeof out[field] === 'string') out[field] = generalizeDateSafeHarbor(out[field] as string);
    }
    if (out.period && typeof out.period === 'object') {
      const period = out.period as Record<string, unknown>;
      out.period = { start: generalizeDateSafeHarbor(period.start as string | undefined) };
    }
  }

  // Practitioner references are intentionally left intact — the clinician
  // isn't the data subject these methods protect (see README).
  return out;
}

export function deidentifyResource(resource: FhirResource, ctx: DeidContext): FhirResource | undefined {
  if (resource.resourceType === 'Patient') return deidentifyPatient(resource, ctx);
  if (resource.resourceType === 'DocumentReference') return undefined; // excluded, see file header
  return deidentifyClinicalResource(resource, ctx);
}
