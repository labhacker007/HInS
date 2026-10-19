/**
 * Clinical-track FHIR builders: triage, consult note, coded diagnoses,
 * inter-department referrals. Pure functions with TYPE-ONLY imports so
 * the exact same code is exercised by the UI (TriageForm, ConsultNote,
 * ReferralPanel, ...) and by the live verification script
 * (scripts/verify/verify-clinical.mjs runs this file via Node's type
 * stripping). Keep it free of runtime imports.
 *
 * FHIR shapes (R4):
 *  - Triage visit = Encounter, type HINS_ENCOUNTER_TYPE|triage-visit,
 *    serviceProvider = department Organization, priority = acuity
 *    (v3-ActPriority + our own 1-5 acuity coding so sorting is exact),
 *    reasonCode.text = chief complaint, period.start = arrival time.
 *    Queue status: planned/arrived/triaged = waiting, in-progress =
 *    in-consult, finished = done.
 *  - Vitals = one vital-signs Observation per LOINC code (no BP panel
 *    85354-9; systolic/diastolic recorded as two separate Observations).
 *  - Acuity = Observation LOINC 75636-1 "Emergency severity index [ESI]".
 *  - Consult note = DocumentReference type LOINC 11488-4, text/plain
 *    SOAP body (same content shape as the existing VersionedNote flow so
 *    edit + version history keeps working), context.encounter,
 *    context.related -> the Conditions recorded with it.
 *  - Diagnosis = Condition (SNOMED CT + ICD-10 codings), category
 *    encounter-diagnosis, encounter, recorder/asserter.
 *  - Referral = ServiceRequest, category SNOMED 3457005 "Patient
 *    referral", performer[0] = receiving department Organization.
 *
 * Known gap, stated plainly:
 *  - Acuity 1-5 is the nurse's chosen level, labelled "ESI-style". The
 *    ESI decision algorithm itself (ENA) is not implemented or enforced.
 *  - Referral "accepted" is not a FHIR ServiceRequest status. We record
 *    acceptance by appending the accepting Practitioner to performer[]
 *    plus a note; a proper Task-based workflow (Task.focus = referral,
 *    requested -> accepted -> completed) is future work.
 *  - The sending department isn't modelled (only requester Practitioner);
 *    staff -> department comes from PractitionerRole, not looked up here.
 */
import type {
  CodeableConcept,
  Condition,
  DocumentReference,
  Encounter,
  Observation,
  Reference as FhirReference,
  ServiceRequest,
} from '@medplum/fhirtypes';
import type { TermEntry } from './terminology.js';

// Loose reference type so callers can pass any Practitioner/Patient/... ref.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reference = FhirReference<any>;

export const LOINC = 'http://loinc.org';
export const SNOMED = 'http://snomed.info/sct';
export const ICD10 = 'http://hl7.org/fhir/sid/icd-10';
export const UCUM = 'http://unitsofmeasure.org';
export const HINS_ENCOUNTER_TYPE = 'https://hins.example/fhir/encounter-type';
export const HINS_ACUITY = 'https://hins.example/fhir/triage-acuity';
const ACT_PRIORITY = 'http://terminology.hl7.org/CodeSystem/v3-ActPriority';
const ACT_CODE = 'http://terminology.hl7.org/CodeSystem/v3-ActCode';
const OBS_CATEGORY = 'http://terminology.hl7.org/CodeSystem/observation-category';

export const TRIAGE_TYPE: CodeableConcept = {
  coding: [{ system: HINS_ENCOUNTER_TYPE, code: 'triage-visit', display: 'Triaged visit' }],
  text: 'Triaged visit',
};

/** LOINC codes verified against tx.fhir.org ($lookup). */
export const VITALS = [
  { key: 'systolic', code: '8480-6', display: 'Systolic blood pressure', unit: 'mmHg', ucum: 'mm[Hg]' },
  { key: 'diastolic', code: '8462-4', display: 'Diastolic blood pressure', unit: 'mmHg', ucum: 'mm[Hg]' },
  { key: 'heartRate', code: '8867-4', display: 'Heart rate', unit: 'beats/min', ucum: '/min' },
  { key: 'respRate', code: '9279-1', display: 'Respiratory rate', unit: 'breaths/min', ucum: '/min' },
  { key: 'temperature', code: '8310-5', display: 'Body temperature', unit: '°C', ucum: 'Cel' },
  { key: 'spo2', code: '59408-5', display: 'Oxygen saturation in Arterial blood by Pulse oximetry', unit: '%', ucum: '%' },
] as const;
export type VitalKey = (typeof VITALS)[number]['key'];
export const PAIN_LOINC = { code: '72514-3', display: 'Pain severity - 0-10 verbal numeric rating [Score] - Reported' };
export const ESI_LOINC = { code: '75636-1', display: 'Emergency severity index [ESI]' };
export const CONSULT_NOTE_LOINC = { code: '11488-4', display: 'Consult note' };
export const REFERRAL_CATEGORY: CodeableConcept = {
  coding: [{ system: SNOMED, code: '3457005', display: 'Patient referral' }],
  text: 'Referral',
};

export const ACUITY_LEVELS = [
  { level: 1, label: '1 — Resuscitation', priority: 'S', priorityDisplay: 'stat', color: 'red' },
  { level: 2, label: '2 — Emergent', priority: 'EM', priorityDisplay: 'emergency', color: 'orange' },
  { level: 3, label: '3 — Urgent', priority: 'UR', priorityDisplay: 'urgent', color: 'yellow' },
  { level: 4, label: '4 — Less urgent', priority: 'R', priorityDisplay: 'routine', color: 'green' },
  { level: 5, label: '5 — Non-urgent', priority: 'EL', priorityDisplay: 'elective', color: 'blue' },
] as const;

// ---------- Triage ----------

export interface TriageInput {
  patient: Reference;
  department: Reference; // Organization
  departmentCode: string;
  arrival: string; // ISO
  chiefComplaint: string;
  acuity: number; // 1..5
  triagedBy?: Reference; // Practitioner
}

export function buildTriageEncounter(t: TriageInput): Encounter {
  const a = ACUITY_LEVELS.find((x) => x.level === t.acuity);
  if (!a) throw new Error(`Acuity must be 1-5, got ${t.acuity}`);
  return {
    resourceType: 'Encounter',
    status: 'triaged',
    class:
      t.departmentCode === 'emergency'
        ? { system: ACT_CODE, code: 'EMER', display: 'emergency' }
        : { system: ACT_CODE, code: 'AMB', display: 'ambulatory' },
    type: [TRIAGE_TYPE],
    priority: {
      coding: [
        { system: ACT_PRIORITY, code: a.priority, display: a.priorityDisplay },
        { system: HINS_ACUITY, code: String(a.level), display: `Acuity ${a.label}` },
      ],
      text: `ESI-style acuity ${a.level}`,
    },
    subject: t.patient,
    serviceProvider: t.department,
    // Participant type left as free text: v3-ParticipationType has no "triage" code.
    participant: t.triagedBy ? [{ type: [{ text: 'Triage' }], individual: t.triagedBy }] : undefined,
    reasonCode: [{ text: t.chiefComplaint }],
    period: { start: t.arrival },
  };
}

export type VitalValues = Partial<Record<VitalKey, number | undefined>>;

export function buildTriageObservations(args: {
  patient: Reference;
  encounter: Reference;
  performer?: Reference;
  effective: string;
  vitals: VitalValues;
  pain?: number;
  acuity: number;
}): Observation[] {
  const base = {
    resourceType: 'Observation' as const,
    status: 'final' as const,
    subject: args.patient,
    encounter: args.encounter,
    performer: args.performer ? [args.performer] : undefined,
    effectiveDateTime: args.effective,
  };
  const vitalCat = [{ coding: [{ system: OBS_CATEGORY, code: 'vital-signs', display: 'Vital Signs' }] }];
  const surveyCat = [{ coding: [{ system: OBS_CATEGORY, code: 'survey', display: 'Survey' }] }];
  const out: Observation[] = [];
  for (const v of VITALS) {
    const value = args.vitals[v.key];
    if (value === undefined || Number.isNaN(value)) continue;
    out.push({
      ...base,
      category: vitalCat,
      code: { coding: [{ system: LOINC, code: v.code, display: v.display }], text: v.display },
      valueQuantity: { value, unit: v.unit, system: UCUM, code: v.ucum },
    });
  }
  if (args.pain !== undefined && !Number.isNaN(args.pain)) {
    out.push({
      ...base,
      category: surveyCat,
      code: { coding: [{ system: LOINC, ...PAIN_LOINC }], text: 'Pain score (0-10)' },
      valueInteger: args.pain,
    });
  }
  out.push({
    ...base,
    category: surveyCat,
    code: { coding: [{ system: LOINC, ...ESI_LOINC }], text: 'Triage acuity (ESI-style)' },
    valueInteger: args.acuity,
  });
  return out;
}

export function acuityOf(e: Encounter): number {
  const c = e.priority?.coding?.find((x) => x.system === HINS_ACUITY)?.code;
  const n = c ? Number(c) : NaN;
  return Number.isFinite(n) ? n : 99; // un-triaged sorts last
}

export type QueueStatus = 'waiting' | 'in-consult' | 'done' | 'other';
export function queueStatus(e: Encounter): QueueStatus {
  switch (e.status) {
    case 'planned':
    case 'arrived':
    case 'triaged':
      return 'waiting';
    case 'in-progress':
      return 'in-consult';
    case 'finished':
      return 'done';
    default:
      return 'other';
  }
}

/** Queue order: most acute first (1 before 5), then earliest arrival first. */
export function sortTriageQueue(list: Encounter[]): Encounter[] {
  return [...list].sort((a, b) => {
    const d = acuityOf(a) - acuityOf(b);
    if (d !== 0) return d;
    return (a.period?.start ?? '').localeCompare(b.period?.start ?? '');
  });
}

// ---------- Consult note + diagnoses ----------

export interface Soap {
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
}

export function soapToText(s: Soap): string {
  return [
    ['SUBJECTIVE', s.subjective],
    ['OBJECTIVE', s.objective],
    ['ASSESSMENT', s.assessment],
    ['PLAN', s.plan],
  ]
    .map(([h, b]) => `${h}:\n${(b ?? '').trim() || '—'}`)
    .join('\n\n');
}

export type VerificationStatus = 'provisional' | 'confirmed' | 'differential';

export function buildDiagnosisCondition(args: {
  term: TermEntry;
  verification: VerificationStatus;
  patient: Reference;
  encounter: Reference;
  recorder?: Reference;
  recordedDate: string;
}): Condition {
  return {
    resourceType: 'Condition',
    clinicalStatus: {
      coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active', display: 'Active' }],
    },
    verificationStatus: {
      coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: args.verification }],
    },
    category: [
      {
        coding: [
          { system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: 'encounter-diagnosis', display: 'Encounter Diagnosis' },
        ],
      },
    ],
    code: {
      coding: [
        { system: SNOMED, code: args.term.snomed, display: args.term.display },
        { system: ICD10, code: args.term.icd10, display: args.term.icd10Display },
      ],
      text: args.term.display,
    },
    subject: args.patient,
    encounter: args.encounter,
    recorder: args.recorder,
    asserter: args.recorder,
    recordedDate: args.recordedDate,
  };
}

/** Latin-1 base64 — same encoding the existing VersionedNote uses (btoa/atob). */
function toBase64(text: string): string {
  // Replace characters btoa can't encode rather than throwing mid-save.
  return btoa(text.replace(/[^\u0000-ÿ]/g, '?'));
}

export function buildConsultDocumentReference(args: {
  soap: Soap;
  patient: Reference;
  encounter: Reference;
  author?: Reference;
  conditions: Reference[];
  date: string;
}): DocumentReference {
  return {
    resourceType: 'DocumentReference',
    status: 'current',
    docStatus: 'final',
    type: { coding: [{ system: LOINC, ...CONSULT_NOTE_LOINC }], text: 'Consult note' },
    category: [{ text: 'Clinical note' }],
    subject: args.patient,
    date: args.date,
    author: args.author ? [args.author] : undefined,
    context: {
      encounter: [args.encounter],
      related: args.conditions.length ? args.conditions : undefined,
    },
    content: [{ attachment: { contentType: 'text/plain', data: toBase64(soapToText(args.soap)), title: 'Consult note (SOAP)' } }],
  };
}

// ---------- Referrals ----------

export type ReferralPriority = 'routine' | 'urgent' | 'asap' | 'stat';

export function buildReferral(args: {
  patient: Reference;
  toDepartment: Reference; // Organization
  requester?: Reference;
  encounter?: Reference;
  what: string;
  reason: string;
  reasonCondition?: Reference;
  priority: ReferralPriority;
  authoredOn: string;
}): ServiceRequest {
  return {
    resourceType: 'ServiceRequest',
    status: 'active',
    intent: 'order',
    category: [REFERRAL_CATEGORY],
    priority: args.priority,
    code: { text: args.what },
    subject: args.patient,
    encounter: args.encounter,
    requester: args.requester,
    performer: [args.toDepartment],
    reasonCode: args.reason ? [{ text: args.reason }] : undefined,
    reasonReference: args.reasonCondition ? [args.reasonCondition] : undefined,
    authoredOn: args.authoredOn,
  };
}

export type ReferralState = 'new' | 'accepted' | 'completed' | 'revoked' | 'other';
export function referralState(sr: ServiceRequest): ReferralState {
  if (sr.status === 'completed') return 'completed';
  if (sr.status === 'revoked') return 'revoked';
  if (sr.status !== 'active') return 'other';
  return sr.performer?.some((p) => p.reference?.startsWith('Practitioner/')) ? 'accepted' : 'new';
}

export function acceptReferral(sr: ServiceRequest, by: Reference, at: string): ServiceRequest {
  return {
    ...sr,
    performer: [...(sr.performer ?? []), by],
    note: [...(sr.note ?? []), { authorReference: by, time: at, text: `Accepted by ${by.display ?? by.reference}` }],
  };
}

export function completeReferral(sr: ServiceRequest, by: Reference | undefined, at: string, text?: string): ServiceRequest {
  return {
    ...sr,
    status: 'completed',
    note: [
      ...(sr.note ?? []),
      { authorReference: by, time: at, text: text?.trim() ? `Completed: ${text.trim()}` : 'Completed' },
    ],
  };
}
