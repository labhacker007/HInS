import type { BinarySource, MedplumClient } from '@medplum/core';
// Required: RBAC (seed-access-policies.mjs) only lets lab/radiology staff see DocumentReferences carrying this category.
import { docCategory } from './access.js';
import type {
  Attachment,
  Bundle,
  Coding,
  DiagnosticReport,
  DocumentReference,
  ImagingStudy,
  Observation,
  Organization,
  Patient,
  Reference,
  Resource,
  ServiceRequest,
  Specimen,
  Task,
} from '@medplum/fhirtypes';
import { DEPT_SYSTEM, ROLE_SYSTEM, deptName, type DepartmentCode, type RoleCode } from './hospital.js';
import { parseOru, type ParsedOru } from './hl7Oru.js';
import { dicomDateToFhir } from './dicomHeader.js';

/**
 * Diagnostics workflow (lab + radiology) — every FHIR read/write the
 * Orders tab, the /lab and /radiology work queues, ResultUpload and the
 * report sign-off make lives here, so the live verification scripts can
 * drive exactly this code against Medplum with a node MedplumClient.
 *
 * ── Resource model ──────────────────────────────────────────────────────
 *  ServiceRequest  the order. performer = Laboratory / Radiology department
 *                  Organization (hospital.ts DEPT_SYSTEM). status active ->
 *                  completed on final sign-off, or revoked if cancelled.
 *  Task            the department's fulfilment tracker (focus = order).
 *                  ServiceRequest.status has no "in progress" value, so
 *                  "in progress" lives here, per FHIR's workflow pattern.
 *  Specimen        lab collection; linked from ServiceRequest.specimen
 *                  (Specimen has no standard search param back to the order).
 *  DiagnosticReport ONE working report per order, created by the first
 *                  upload, appended to by later uploads (PDF + HL7 for the
 *                  same order end up on one report). preliminary -> final
 *                  (sign-off) -> amended (corrections; prior versions stay
 *                  in Medplum _history — nothing is ever deleted).
 *  Observation     structured results (HL7 OBX / FHIR import); written
 *                  'preliminary', flipped to 'final' at sign-off.
 *  ImagingStudy    DICOM metadata; the .dcm itself is a Binary referenced
 *                  from a DocumentReference (application/dicom).
 *
 * ── Codes ───────────────────────────────────────────────────────────────
 * Lab test LOINC codes below were each verified against the NLM Clinical
 * Tables LOINC service (clinicaltables.nlm.nih.gov/api/loinc_items) on
 * 2026-10-20 — not typed from memory. Imaging orders are FREE TEXT: no
 * licensed procedure terminology (e.g. SNOMED/RadLex/LOINC-RSNA playbook)
 * is loaded here, so none is invented. Category codes are the published
 * FHIR example value sets (SNOMED 108252007 / 363679005 for
 * ServiceRequest.category; HL7 v2-0074 LAB / RAD for DiagnosticReport).
 *
 * ── Known gaps, stated plainly ──────────────────────────────────────────
 * - Sign-off is gated to pathologist/radiologist PractitionerRoles IN THE UI
 *   ONLY. A direct FHIR write can still finalize any report — server-side
 *   enforcement (AccessPolicy/Bot) belongs to the RBAC track. Until that
 *   track seeds PractitionerRoles, NOBODY sees the sign-off button.
 * - Multi-resource steps are sequential writes, not atomic (Medplum
 *   transaction Bundles are not atomic here either). Each step re-reads
 *   fresh state first (cache: 'reload') and the caller is told exactly
 *   which step failed; a half-finished sign-off is re-runnable.
 * - No HL7 MLLP listener / instrument interface — results arrive by upload.
 * - No billing/charge capture on order completion.
 */

export type DiagKind = 'laboratory' | 'imaging';
export type OrderPriority = 'routine' | 'urgent' | 'asap' | 'stat';

export const KIND_DEPT: Record<DiagKind, DepartmentCode> = { laboratory: 'laboratory', imaging: 'radiology' };
export const SIGNER_ROLE: Record<DiagKind, RoleCode> = { laboratory: 'pathologist', imaging: 'radiologist' };

const SR_CATEGORY: Record<DiagKind, Coding> = {
  laboratory: { system: 'http://snomed.info/sct', code: '108252007', display: 'Laboratory procedure' },
  imaging: { system: 'http://snomed.info/sct', code: '363679005', display: 'Imaging' },
};
const DR_CATEGORY: Record<DiagKind, Coding> = {
  laboratory: { system: 'http://terminology.hl7.org/CodeSystem/v2-0074', code: 'LAB', display: 'Laboratory' },
  imaging: { system: 'http://terminology.hl7.org/CodeSystem/v2-0074', code: 'RAD', display: 'Radiology' },
};
const OBS_CATEGORY: Record<DiagKind, Coding> = {
  laboratory: { system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory', display: 'Laboratory' },
  imaging: { system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'imaging', display: 'Imaging' },
};
export const LOINC = 'http://loinc.org';

/** Verified LOINC codes (see header). `display` is the LOINC long common name. */
export const LAB_TESTS: { code: string; display: string; label: string }[] = [
  { code: '58410-2', display: 'CBC panel - Blood by Automated count', label: 'Complete blood count (CBC)' },
  { code: '24323-8', display: 'Comprehensive metabolic 2000 panel - Serum or Plasma', label: 'Comprehensive metabolic panel (CMP)' },
  { code: '24362-6', display: 'Renal function 2000 panel - Serum or Plasma', label: 'Renal function panel' },
  { code: '24325-3', display: 'Hepatic function 2000 panel - Serum or Plasma', label: 'Liver function panel' },
  { code: '24331-1', display: 'Lipid 1996 panel - Serum or Plasma', label: 'Lipid panel' },
  { code: '4548-4', display: 'Hemoglobin A1c/Hemoglobin.total in Blood', label: 'HbA1c' },
  { code: '2093-3', display: 'Cholesterol [Mass/volume] in Serum or Plasma', label: 'Total cholesterol' },
  { code: '2345-7', display: 'Glucose [Mass/volume] in Serum or Plasma', label: 'Glucose' },
  { code: '2160-0', display: 'Creatinine [Mass/volume] in Serum or Plasma', label: 'Creatinine' },
  { code: '3016-3', display: 'Thyrotropin [Units/volume] in Serum or Plasma', label: 'TSH' },
  { code: '1988-5', display: 'C reactive protein [Mass/volume] in Serum or Plasma', label: 'C-reactive protein (CRP)' },
  { code: '5902-2', display: 'Prothrombin time (PT)', label: 'Prothrombin time (PT)' },
  { code: '24356-8', display: 'Urinalysis complete panel - Urine', label: 'Urinalysis, complete' },
];

/** Suggestions only — stored as free text (no verified imaging procedure codes). */
export const IMAGING_SUGGESTIONS = [
  'X-ray chest PA view',
  'X-ray chest AP view',
  'Ultrasound abdomen',
  'Ultrasound pelvis',
  'CT head without contrast',
  'CT abdomen and pelvis with contrast',
  'MRI brain without contrast',
  'MRI lumbar spine',
  'Echocardiogram (transthoracic)',
];

export const PRIORITY_RANK: Record<string, number> = { stat: 0, asap: 1, urgent: 2, routine: 3 };
export const PRIORITY_COLOR: Record<string, string> = { stat: 'red', asap: 'orange', urgent: 'yellow', routine: 'gray' };

export function kindOf(sr: ServiceRequest): DiagKind {
  return sr.category?.some((c) => c.coding?.some((x) => x.code === SR_CATEGORY.imaging.code)) ? 'imaging' : 'laboratory';
}

export const ref = <T extends Resource>(r: T & { id?: string }, display?: string): Reference<T> => ({
  reference: `${r.resourceType}/${r.id}`,
  display,
});

const deptCache = new Map<string, Organization>();
export async function findDepartment(medplum: MedplumClient, code: DepartmentCode): Promise<Organization> {
  const cached = deptCache.get(code);
  if (cached) return cached;
  const org = await medplum.searchOne('Organization', { identifier: `${DEPT_SYSTEM}|${code}` });
  if (!org) throw new Error(`Department "${deptName(code)}" is not seeded — run scripts/seed/seed-departments.mjs`);
  deptCache.set(code, org);
  return org;
}

// ─── Roles ─────────────────────────────────────────────────────────────────

export async function getMyRoleCodes(medplum: MedplumClient, practitionerId: string | undefined): Promise<Set<string>> {
  if (!practitionerId) return new Set();
  const roles = await medplum.searchResources('PractitionerRole', {
    practitioner: `Practitioner/${practitionerId}`,
    active: 'true',
  });
  const out = new Set<string>();
  for (const r of roles) for (const c of r.code ?? []) for (const x of c.coding ?? []) if (x.system === ROLE_SYSTEM && x.code) out.add(x.code);
  return out;
}

export function canSignOff(roles: Set<string>, kind: DiagKind): boolean {
  return roles.has(SIGNER_ROLE[kind]);
}

// ─── Ordering ──────────────────────────────────────────────────────────────

export interface NewOrder {
  patientId: string;
  kind: DiagKind;
  /** LOINC code for lab tests from LAB_TESTS; omitted for free-text orders. */
  loinc?: string;
  text: string;
  priority: OrderPriority;
  requesterId?: string;
  requesterName?: string;
  encounterId?: string;
  note?: string;
}

export async function createOrder(medplum: MedplumClient, o: NewOrder): Promise<ServiceRequest> {
  if (!o.text.trim()) throw new Error('Test / study is required');
  const dept = await findDepartment(medplum, KIND_DEPT[o.kind]);
  const lab = o.loinc ? LAB_TESTS.find((t) => t.code === o.loinc) : undefined;
  if (o.loinc && !lab) throw new Error(`LOINC ${o.loinc} is not in the verified catalogue`);
  return medplum.createResource<ServiceRequest>({
    resourceType: 'ServiceRequest',
    status: 'active',
    intent: 'order',
    category: [{ coding: [SR_CATEGORY[o.kind]] }],
    code: lab ? { coding: [{ system: LOINC, code: lab.code, display: lab.display }], text: lab.label } : { text: o.text.trim() },
    priority: o.priority,
    subject: { reference: `Patient/${o.patientId}` },
    encounter: o.encounterId ? { reference: `Encounter/${o.encounterId}` } : undefined,
    requester: o.requesterId ? { reference: `Practitioner/${o.requesterId}`, display: o.requesterName } : undefined,
    performer: [ref(dept, dept.name)],
    authoredOn: new Date().toISOString(),
    note: o.note?.trim() ? [{ text: o.note.trim() }] : undefined,
  });
}

/** Re-read the order fresh (never from cache) and require it to still be active. */
export async function assertOrderActive(medplum: MedplumClient, srId: string): Promise<ServiceRequest> {
  const sr = await medplum.readResource('ServiceRequest', srId, { cache: 'reload' });
  if (sr.status !== 'active') throw new Error(`Order is now "${sr.status}" — no further work can be recorded against it.`);
  return sr;
}

export async function cancelOrder(medplum: MedplumClient, srId: string, reason: string): Promise<ServiceRequest> {
  const sr = await assertOrderActive(medplum, srId);
  const reports = await reportsForOrder(medplum, srId);
  if (reports.length > 0) throw new Error('A result has already been uploaded for this order — it cannot be cancelled here.');
  const updated = await medplum.updateResource<ServiceRequest>({
    ...sr,
    status: 'revoked',
    note: [...(sr.note ?? []), { text: `Cancelled: ${reason || 'no reason given'}`, time: new Date().toISOString() }],
  });
  for (const t of await tasksForOrder(medplum, srId)) {
    if (t.status !== 'completed' && t.status !== 'cancelled') await medplum.updateResource<Task>({ ...t, status: 'cancelled' });
  }
  return updated;
}

// ─── Work queue ────────────────────────────────────────────────────────────

export interface QueueItem {
  order: ServiceRequest;
  patient?: Patient;
  task?: Task;
  specimens: Specimen[];
  report?: DiagnosticReport;
}

function byPriorityThenAge(a: ServiceRequest, b: ServiceRequest): number {
  const p = (PRIORITY_RANK[a.priority ?? 'routine'] ?? 9) - (PRIORITY_RANK[b.priority ?? 'routine'] ?? 9);
  return p !== 0 ? p : (a.authoredOn ?? '').localeCompare(b.authoredOn ?? '');
}

export async function loadQueue(medplum: MedplumClient, dept: DepartmentCode): Promise<QueueItem[]> {
  const org = await findDepartment(medplum, dept);
  // URLSearchParams so _include repeats (an array value would be comma-joined, which Medplum rejects).
  const params = new URLSearchParams({ performer: `Organization/${org.id}`, status: 'active', _count: '200' });
  params.append('_include', 'ServiceRequest:subject');
  params.append('_include', 'ServiceRequest:specimen');
  const bundle: Bundle = await medplum.search('ServiceRequest', params, { cache: 'reload' });
  const all = (bundle.entry ?? []).map((e) => e.resource).filter(Boolean) as Resource[];
  const orders = all.filter((r): r is ServiceRequest => r.resourceType === 'ServiceRequest').sort(byPriorityThenAge);
  if (orders.length === 0) return [];
  const byRef = new Map(all.map((r) => [`${r.resourceType}/${r.id}`, r]));
  const ids = orders.map((o) => `ServiceRequest/${o.id}`).join(',');
  const [tasks, reports] = await Promise.all([
    medplum.searchResources('Task', { focus: ids, _count: '200' }, { cache: 'reload' }),
    medplum.searchResources('DiagnosticReport', { 'based-on': ids, _count: '200' }, { cache: 'reload' }),
  ]);
  return orders.map((order) => {
    const key = `ServiceRequest/${order.id}`;
    return {
      order,
      patient: byRef.get(order.subject?.reference ?? '') as Patient | undefined,
      task: tasks.find((t) => t.focus?.reference === key && t.status !== 'cancelled'),
      specimens: (order.specimen ?? []).map((s) => byRef.get(s.reference ?? '') as Specimen).filter(Boolean),
      report: reports.find((r) => r.basedOn?.some((b) => b.reference === key)),
    };
  });
}

export async function tasksForOrder(medplum: MedplumClient, srId: string): Promise<Task[]> {
  return medplum.searchResources('Task', { focus: `ServiceRequest/${srId}` }, { cache: 'reload' });
}

export async function reportsForOrder(medplum: MedplumClient, srId: string): Promise<DiagnosticReport[]> {
  return medplum.searchResources('DiagnosticReport', { 'based-on': `ServiceRequest/${srId}` }, { cache: 'reload' });
}

/** Ensure a fulfilment Task exists for the order and is in-progress. */
export async function markInProgress(
  medplum: MedplumClient,
  srId: string,
  opts: { businessStatus?: string; performerId?: string } = {},
): Promise<Task> {
  const sr = await assertOrderActive(medplum, srId);
  const existing = (await tasksForOrder(medplum, srId)).find((t) => t.status !== 'cancelled' && t.status !== 'completed');
  const businessStatus = opts.businessStatus ? { text: opts.businessStatus } : existing?.businessStatus;
  if (existing) {
    if (existing.status === 'in-progress' && existing.businessStatus?.text === businessStatus?.text) return existing;
    return medplum.updateResource<Task>({ ...existing, status: 'in-progress', businessStatus, lastModified: new Date().toISOString() });
  }
  return medplum.createResource<Task>({
    resourceType: 'Task',
    status: 'in-progress',
    intent: 'order',
    priority: sr.priority,
    focus: { reference: `ServiceRequest/${srId}` },
    for: sr.subject,
    encounter: sr.encounter,
    owner: sr.performer?.[0],
    requester: opts.performerId ? { reference: `Practitioner/${opts.performerId}` } : undefined,
    businessStatus,
    authoredOn: new Date().toISOString(),
    lastModified: new Date().toISOString(),
    description: sr.code?.text,
  });
}

export async function collectSpecimen(
  medplum: MedplumClient,
  srId: string,
  s: { typeText: string; collectorId?: string; note?: string },
): Promise<Specimen> {
  const sr = await assertOrderActive(medplum, srId);
  if (kindOf(sr) !== 'laboratory') throw new Error('Specimens are collected for laboratory orders only');
  const specimen = await medplum.createResource<Specimen>({
    resourceType: 'Specimen',
    status: 'available',
    subject: sr.subject,
    request: [{ reference: `ServiceRequest/${srId}` }],
    type: s.typeText.trim() ? { text: s.typeText.trim() } : undefined,
    receivedTime: new Date().toISOString(),
    collection: {
      collector: s.collectorId ? { reference: `Practitioner/${s.collectorId}` } : undefined,
      collectedDateTime: new Date().toISOString(),
    },
    note: s.note?.trim() ? [{ text: s.note.trim() }] : undefined,
  });
  // Link back from the order (fresh copy, so a concurrent edit isn't clobbered with stale data).
  const fresh = await assertOrderActive(medplum, srId);
  await medplum.updateResource<ServiceRequest>({
    ...fresh,
    specimen: [...(fresh.specimen ?? []), { reference: `Specimen/${specimen.id}` }],
  });
  await markInProgress(medplum, srId, { businessStatus: 'Specimen collected', performerId: s.collectorId });
  return specimen;
}

// ─── Working report ────────────────────────────────────────────────────────

const OPEN_REPORT = new Set(['registered', 'partial', 'preliminary']);

async function appendToReport(
  medplum: MedplumClient,
  sr: ServiceRequest,
  add: { result?: Reference<Observation>[]; presentedForm?: Attachment[]; imagingStudy?: Reference<ImagingStudy>[]; conclusion?: string; code?: DiagnosticReport['code']; effectiveDateTime?: string },
): Promise<DiagnosticReport> {
  const reports = await reportsForOrder(medplum, sr.id as string);
  const signed = reports.find((r) => r.status === 'final' || r.status === 'amended' || r.status === 'corrected');
  if (signed) throw new Error('This order\'s report is already signed — corrections go through "Amend" on the report.');
  const open = reports.find((r) => OPEN_REPORT.has(r.status));
  const kind = kindOf(sr);
  if (!open) {
    const dept = await findDepartment(medplum, KIND_DEPT[kind]);
    return medplum.createResource<DiagnosticReport>({
      resourceType: 'DiagnosticReport',
      status: 'preliminary',
      category: [{ coding: [DR_CATEGORY[kind]] }],
      code: sr.code ?? add.code ?? { text: 'Diagnostic report' },
      subject: sr.subject,
      encounter: sr.encounter,
      basedOn: [{ reference: `ServiceRequest/${sr.id}` }],
      performer: [ref(dept, dept.name)],
      effectiveDateTime: add.effectiveDateTime ?? new Date().toISOString(),
      result: add.result,
      presentedForm: add.presentedForm,
      imagingStudy: add.imagingStudy,
      conclusion: add.conclusion,
    });
  }
  const mergeRefs = <T extends Resource>(a: Reference<T>[] = [], b: Reference<T>[] = []) => {
    const seen = new Set(a.map((x) => x.reference));
    return [...a, ...b.filter((x) => !seen.has(x.reference))];
  };
  const result = mergeRefs(open.result, add.result);
  const imagingStudy = mergeRefs(open.imagingStudy, add.imagingStudy);
  const presentedForm = [...(open.presentedForm ?? []), ...(add.presentedForm ?? [])];
  return medplum.updateResource<DiagnosticReport>({
    ...open,
    status: 'preliminary',
    result: result.length ? result : undefined,
    imagingStudy: imagingStudy.length ? imagingStudy : undefined,
    presentedForm: presentedForm.length ? presentedForm : undefined,
    conclusion: open.conclusion ?? add.conclusion,
  });
}

export interface ImportResult {
  report: DiagnosticReport;
  observations: Observation[];
  warnings: string[];
}

const toBinary = (d: BinarySource | ArrayBuffer): BinarySource => (d instanceof ArrayBuffer ? new Uint8Array(d) : d);

// (a) PDF / JPEG / PNG ─────────────────────────────────────────────────────

export const DOCUMENT_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];

export async function uploadResultDocument(
  medplum: MedplumClient,
  srId: string,
  f: { data: BinarySource | ArrayBuffer; filename: string; contentType: string; uploaderId?: string; title?: string },
): Promise<ImportResult> {
  if (!DOCUMENT_TYPES.includes(f.contentType)) throw new Error(`Unsupported document type ${f.contentType} — PDF, JPEG or PNG only.`);
  const sr = await assertOrderActive(medplum, srId);
  const attachment = await medplum.createAttachment({ data: toBinary(f.data), filename: f.filename, contentType: f.contentType });
  attachment.title = f.title || f.filename;
  await medplum.createResource<DocumentReference>({
    resourceType: 'DocumentReference',
    status: 'current',
    type: { text: kindOf(sr) === 'imaging' ? 'Radiology result document' : 'Laboratory result document' },
    category: [docCategory(kindOf(sr) === 'imaging' ? 'imaging-report' : 'lab-report')],
    subject: sr.subject as Reference<Patient>,
    date: new Date().toISOString(),
    author: f.uploaderId ? [{ reference: `Practitioner/${f.uploaderId}` }] : undefined,
    description: attachment.title,
    content: [{ attachment }],
    context: { related: [{ reference: `ServiceRequest/${srId}` }], encounter: sr.encounter ? [sr.encounter] : undefined },
  });
  const report = await appendToReport(medplum, sr, { presentedForm: [attachment] });
  await markInProgress(medplum, srId, { businessStatus: 'Result uploaded — awaiting sign-off', performerId: f.uploaderId });
  return { report, observations: [], warnings: [] };
}

// Shared: write structured Observations, rolling back (entered-in-error) on failure.

async function writeObservations(medplum: MedplumClient, sr: ServiceRequest, obs: Observation[]): Promise<Observation[]> {
  const created: Observation[] = [];
  try {
    for (const o of obs) {
      created.push(
        await medplum.createResource<Observation>({
          ...o,
          id: undefined,
          meta: undefined,
          subject: sr.subject,
          encounter: sr.encounter,
          basedOn: [{ reference: `ServiceRequest/${sr.id}` }],
          category: o.category?.length ? o.category : [{ coding: [OBS_CATEGORY[kindOf(sr)]] }],
        }),
      );
    }
  } catch (err) {
    // Non-destructive rollback: never delete, mark the partial writes as errors.
    for (const c of created) {
      await medplum.updateResource<Observation>({ ...c, status: 'entered-in-error' }).catch(() => undefined);
    }
    throw new Error(`Saving result ${created.length + 1} of ${obs.length} failed (earlier ones marked entered-in-error): ${(err as Error).message}`);
  }
  return created;
}

// (b) FHIR JSON ────────────────────────────────────────────────────────────

export interface PreparedFhirImport {
  report?: DiagnosticReport;
  observations: Observation[];
  warnings: string[];
}

/** Pure: pick the DiagnosticReport/Observations out of the uploaded JSON and normalise them. */
export function prepareFhirImport(json: unknown, sr: ServiceRequest): PreparedFhirImport {
  if (!json || typeof json !== 'object' || !('resourceType' in json)) throw new Error('Not a FHIR resource (no resourceType).');
  const root = json as Resource;
  const resources: Resource[] =
    root.resourceType === 'Bundle'
      ? ((root as Bundle).entry ?? []).map((e) => e.resource).filter((r): r is Resource => !!r)
      : [root];
  const warnings: string[] = [];
  const reports = resources.filter((r): r is DiagnosticReport => r.resourceType === 'DiagnosticReport');
  const observations = resources.filter((r): r is Observation => r.resourceType === 'Observation');
  const other = resources.filter((r) => r.resourceType !== 'DiagnosticReport' && r.resourceType !== 'Observation');
  if (other.length) warnings.push(`Ignored ${other.length} resource(s) that are not DiagnosticReport/Observation (${[...new Set(other.map((r) => r.resourceType))].join(', ')}).`);
  if (reports.length > 1) throw new Error('Upload one DiagnosticReport at a time.');
  if (!reports.length && !observations.length) throw new Error('No DiagnosticReport or Observation found.');
  const contained = reports[0]?.contained?.filter((r): r is Observation => r.resourceType === 'Observation') ?? [];
  if (contained.length) warnings.push(`Using ${contained.length} Observation(s) contained in the DiagnosticReport.`);
  const all = [...observations, ...contained];
  const patientRef = sr.subject?.reference;
  for (const r of [...reports, ...all]) {
    if (r.subject?.reference && r.subject.reference !== patientRef) {
      warnings.push(`${r.resourceType} subject "${r.subject.reference}" replaced with this order's patient (${patientRef}).`);
    }
  }
  const finalish = all.filter((o) => o.status === 'final' || o.status === 'amended' || o.status === 'corrected');
  if (finalish.length) warnings.push(`${finalish.length} Observation(s) arrived as final/amended — stored as preliminary until signed off here.`);
  const normalisedObs = all.map<Observation>((o) => ({
    ...o,
    status: o.status === 'cancelled' || o.status === 'entered-in-error' ? o.status : 'preliminary',
    subject: sr.subject,
    basedOn: [{ reference: `ServiceRequest/${sr.id}` }],
    encounter: sr.encounter,
    // Inter-resource references from the sender's system can't resolve here.
    hasMember: undefined,
    derivedFrom: undefined,
    specimen: undefined,
    performer: undefined,
  }));
  const report = reports[0]
    ? { ...reports[0], status: 'preliminary' as const, subject: sr.subject, basedOn: [{ reference: `ServiceRequest/${sr.id}` }], contained: undefined, result: undefined }
    : undefined;
  if (reports[0]?.result?.length && !all.length) warnings.push('DiagnosticReport.result references Observations that are not in the upload — they were dropped.');
  return { report, observations: normalisedObs, warnings };
}

/** Server-side structural validation ($validate) of each resource before anything is written. */
export async function validateResources(medplum: MedplumClient, resources: Resource[]): Promise<string[]> {
  const errors: string[] = [];
  for (const r of resources) {
    try {
      const outcome = (await medplum.post(medplum.fhirUrl(r.resourceType, '$validate'), { ...r, id: undefined, meta: undefined })) as {
        issue?: { severity: string; diagnostics?: string; details?: { text?: string }; expression?: string[] }[];
      };
      for (const i of outcome.issue ?? []) {
        if (i.severity === 'error' || i.severity === 'fatal') errors.push(`${r.resourceType}: ${i.details?.text ?? i.diagnostics ?? 'invalid'} ${i.expression?.join(',') ?? ''}`.trim());
      }
    } catch (err) {
      errors.push(`${r.resourceType}: ${(err as Error).message}`);
    }
  }
  return errors;
}

export async function importFhirResult(medplum: MedplumClient, srId: string, json: unknown): Promise<ImportResult> {
  const sr = await assertOrderActive(medplum, srId);
  const prep = prepareFhirImport(json, sr);
  const errors = await validateResources(medplum, [...(prep.report ? [prep.report] : []), ...prep.observations]);
  if (errors.length) throw new Error(`Validation failed — nothing was saved:\n${errors.join('\n')}`);
  const observations = await writeObservations(medplum, sr, prep.observations);
  const report = await appendToReport(medplum, sr, {
    result: observations.map((o) => ({ reference: `Observation/${o.id}` })),
    presentedForm: prep.report?.presentedForm,
    conclusion: prep.report?.conclusion,
    effectiveDateTime: prep.report?.effectiveDateTime,
  });
  await markInProgress(medplum, srId, { businessStatus: 'Result uploaded — awaiting sign-off' });
  return { report, observations, warnings: prep.warnings };
}

// (c) HL7 v2 ORU^R01 ───────────────────────────────────────────────────────

export const HL7_V2_CONTENT_TYPE = 'x-application/hl7-v2+er7';

/** True if any PID-3 identifier matches any identifier value on the patient. */
export function oruMatchesPatient(parsed: ParsedOru, patient: Patient | undefined): boolean {
  const mine = new Set((patient?.identifier ?? []).map((i) => i.value).filter(Boolean));
  return parsed.patientIdentifiers.some((v) => mine.has(v));
}

export async function importHl7Oru(
  medplum: MedplumClient,
  srId: string,
  text: string,
  opts: { uploaderId?: string; identityConfirmed?: boolean } = {},
): Promise<ImportResult> {
  const sr = await assertOrderActive(medplum, srId);
  const parsed = parseOru(text);
  const patient = await medplum.readReference(sr.subject as Reference<Patient>);
  if (!oruMatchesPatient(parsed, patient) && !opts.identityConfirmed) {
    throw new Error(
      `Patient identifier in the message (PID-3: ${parsed.patientIdentifiers.join(', ') || 'none'}) does not match this patient — confirm identity before importing.`,
    );
  }
  const observations = await writeObservations(medplum, sr, parsed.observations);
  // Keep the original message verbatim as the source of truth (provenance).
  const source = await medplum.createAttachment({
    data: text,
    filename: `ORU-${parsed.messageControlId ?? Date.now()}.hl7`,
    contentType: HL7_V2_CONTENT_TYPE,
  });
  await medplum.createResource<DocumentReference>({
    resourceType: 'DocumentReference',
    status: 'current',
    type: { text: 'HL7 v2 ORU^R01 source message' },
    category: [docCategory(kindOf(sr) === 'imaging' ? 'imaging-report' : 'lab-report')],
    subject: sr.subject as Reference<Patient>,
    date: new Date().toISOString(),
    author: opts.uploaderId ? [{ reference: `Practitioner/${opts.uploaderId}` }] : undefined,
    description: `From ${parsed.sendingFacility ?? 'unknown sender'}, control id ${parsed.messageControlId ?? '—'}`,
    content: [{ attachment: source }],
    context: { related: [{ reference: `ServiceRequest/${srId}` }] },
  });
  const report = await appendToReport(medplum, sr, {
    result: observations.map((o) => ({ reference: `Observation/${o.id}` })),
    conclusion: parsed.notes.length ? `Lab comments: ${parsed.notes.join(' ')}` : undefined,
    effectiveDateTime: observations.find((o) => o.effectiveDateTime)?.effectiveDateTime,
  });
  await markInProgress(medplum, srId, { businessStatus: 'Result uploaded — awaiting sign-off', performerId: opts.uploaderId });
  return { report, observations, warnings: parsed.warnings };
}

// (d) DICOM ────────────────────────────────────────────────────────────────

export interface DicomFields {
  studyInstanceUid: string;
  seriesInstanceUid?: string;
  sopInstanceUid?: string;
  sopClassUid?: string;
  modality: string;
  studyDate?: string; // YYYYMMDD
  description?: string;
  seriesNumber?: string;
  instanceNumber?: string;
  bodyPart?: string;
}

const DICOM_UID = /^[0-9]+(\.[0-9]+)*$/;
const DCM = 'http://dicom.nema.org/resources/ontology/DCM';

export async function importDicom(
  medplum: MedplumClient,
  srId: string,
  f: { data: BinarySource | ArrayBuffer; filename: string; fields: DicomFields; uploaderId?: string },
): Promise<ImportResult & { study: ImagingStudy }> {
  const { fields } = f;
  if (!DICOM_UID.test(fields.studyInstanceUid) || fields.studyInstanceUid.length > 64) throw new Error('StudyInstanceUID must be a dotted-numeric DICOM UID (≤64 chars).');
  if (!/^[A-Z]{2,3}$/.test(fields.modality)) throw new Error('Modality must be a DICOM modality code, e.g. CR, DX, CT, MR, US.');
  const sr = await assertOrderActive(medplum, srId);
  const warnings: string[] = [];
  const binary = await medplum.createAttachment({ data: toBinary(f.data), filename: f.filename, contentType: 'application/dicom' });

  const modality: Coding = { system: DCM, code: fields.modality };
  const instance =
    fields.sopInstanceUid && fields.sopClassUid
      ? {
          uid: fields.sopInstanceUid,
          sopClass: { system: 'urn:ietf:rfc:3986', code: `urn:oid:${fields.sopClassUid}` },
          number: fields.instanceNumber ? Number(fields.instanceNumber) || undefined : undefined,
        }
      : undefined;
  if (!fields.seriesInstanceUid) warnings.push('No SeriesInstanceUID — the study is recorded without series detail.');
  const studyIdentifier = `urn:oid:${fields.studyInstanceUid}`;
  const existing = await medplum.searchOne('ImagingStudy', { identifier: studyIdentifier }, { cache: 'reload' });
  let study: ImagingStudy;
  if (existing) {
    if (existing.subject?.reference !== sr.subject?.reference) throw new Error('This StudyInstanceUID already belongs to a different patient — refusing to merge.');
    const series = [...(existing.series ?? [])];
    if (fields.seriesInstanceUid) {
      const idx = series.findIndex((s) => s.uid === fields.seriesInstanceUid);
      if (idx < 0) series.push({ uid: fields.seriesInstanceUid, modality, number: Number(fields.seriesNumber) || undefined, instance: instance ? [instance] : undefined });
      else if (instance && !series[idx].instance?.some((i) => i.uid === instance.uid)) series[idx] = { ...series[idx], instance: [...(series[idx].instance ?? []), instance] };
      else warnings.push('This instance is already on the study — only the file was stored again.');
    }
    study = await medplum.updateResource<ImagingStudy>({
      ...existing,
      basedOn: [...(existing.basedOn ?? []).filter((b) => b.reference !== `ServiceRequest/${srId}`), { reference: `ServiceRequest/${srId}` }],
      series,
      numberOfSeries: series.length,
      numberOfInstances: series.reduce((n, s) => n + (s.instance?.length ?? 0), 0),
    });
  } else {
    study = await medplum.createResource<ImagingStudy>({
      resourceType: 'ImagingStudy',
      status: 'available',
      identifier: [{ system: 'urn:dicom:uid', value: studyIdentifier }],
      subject: sr.subject as Reference<Patient>,
      encounter: sr.encounter,
      basedOn: [{ reference: `ServiceRequest/${srId}` }],
      started: dicomDateToFhir(fields.studyDate),
      modality: [modality],
      description: fields.description || undefined,
      numberOfSeries: fields.seriesInstanceUid ? 1 : 0,
      numberOfInstances: instance ? 1 : 0,
      series: fields.seriesInstanceUid
        ? [
            {
              uid: fields.seriesInstanceUid,
              modality,
              number: Number(fields.seriesNumber) || undefined,
              bodySite: fields.bodyPart ? { display: fields.bodyPart } : undefined,
              instance: instance ? [instance] : undefined,
            },
          ]
        : undefined,
    });
  }
  await medplum.createResource<DocumentReference>({
    resourceType: 'DocumentReference',
    status: 'current',
    type: { text: 'DICOM object' },
    category: [docCategory('imaging-report')],
    subject: sr.subject as Reference<Patient>,
    date: new Date().toISOString(),
    author: f.uploaderId ? [{ reference: `Practitioner/${f.uploaderId}` }] : undefined,
    description: `${fields.modality} ${fields.description ?? ''} (${f.filename})`.trim(),
    content: [{ attachment: binary }],
    context: { related: [{ reference: `ServiceRequest/${srId}` }, { reference: `ImagingStudy/${study.id}` }] },
  });
  const report = await appendToReport(medplum, sr, { imagingStudy: [{ reference: `ImagingStudy/${study.id}` }] });
  await markInProgress(medplum, srId, { businessStatus: 'Images received — awaiting report', performerId: f.uploaderId });
  return { report, observations: [], warnings, study };
}

/** DocumentReferences holding the raw .dcm files for an ImagingStudy (for download links). */
export async function dicomFilesForStudy(medplum: MedplumClient, studyId: string): Promise<DocumentReference[]> {
  return medplum.searchResources('DocumentReference', { related: `ImagingStudy/${studyId}` });
}

// ─── Sign-off & amendment ──────────────────────────────────────────────────

export interface SignOffInput {
  conclusion: string;
  interpreterId: string;
  interpreterName?: string;
}

export async function signOffReport(medplum: MedplumClient, reportId: string, s: SignOffInput): Promise<DiagnosticReport> {
  if (!s.conclusion.trim()) throw new Error('A conclusion is required to sign off.');
  const dr = await medplum.readResource('DiagnosticReport', reportId, { cache: 'reload' });
  if (!OPEN_REPORT.has(dr.status)) throw new Error(`Report is already "${dr.status}" — use Amend for corrections.`);
  if (!dr.result?.length && !dr.presentedForm?.length && !dr.imagingStudy?.length) throw new Error('Report has no results, documents or images to sign.');
  // 1. Observations -> final
  for (const r of dr.result ?? []) {
    const o = await medplum.readReference(r as Reference<Observation>, { cache: 'reload' });
    if (o.status === 'preliminary' || o.status === 'registered') await medplum.updateResource<Observation>({ ...o, status: 'final' });
  }
  // 2. Report -> final
  const signed = await medplum.updateResource<DiagnosticReport>({
    ...dr,
    status: 'final',
    conclusion: s.conclusion.trim(),
    resultsInterpreter: [{ reference: `Practitioner/${s.interpreterId}`, display: s.interpreterName }],
    issued: new Date().toISOString(),
  });
  // 3. Order -> completed, 4. Task -> completed
  for (const b of dr.basedOn ?? []) {
    const id = b.reference?.split('/')[1];
    if (!b.reference?.startsWith('ServiceRequest/') || !id) continue;
    const sr = await medplum.readResource('ServiceRequest', id, { cache: 'reload' });
    if (sr.status === 'active') await medplum.updateResource<ServiceRequest>({ ...sr, status: 'completed' });
    for (const t of await tasksForOrder(medplum, id)) {
      if (t.status !== 'completed' && t.status !== 'cancelled') {
        await medplum.updateResource<Task>({ ...t, status: 'completed', businessStatus: { text: 'Report signed' }, lastModified: new Date().toISOString() });
      }
    }
  }
  return signed;
}

/** Correction after sign-off: status 'amended', new conclusion, reason appended. Prior version stays in _history. */
export async function amendReport(
  medplum: MedplumClient,
  reportId: string,
  a: { conclusion: string; reason: string; interpreterId: string; interpreterName?: string },
): Promise<DiagnosticReport> {
  if (!a.reason.trim()) throw new Error('An amendment reason is required.');
  const dr = await medplum.readResource('DiagnosticReport', reportId, { cache: 'reload' });
  if (dr.status !== 'final' && dr.status !== 'amended' && dr.status !== 'corrected') throw new Error(`Only a signed report can be amended (this one is "${dr.status}").`);
  const stamp = `Amended ${new Date().toISOString().slice(0, 16).replace('T', ' ')} by ${a.interpreterName ?? a.interpreterId}: ${a.reason.trim()}`;
  const interpreters = dr.resultsInterpreter ?? [];
  return medplum.updateResource<DiagnosticReport>({
    ...dr,
    status: 'amended',
    conclusion: `${a.conclusion.trim()}\n\n[${stamp}]`,
    resultsInterpreter: interpreters.some((r) => r.reference === `Practitioner/${a.interpreterId}`)
      ? interpreters
      : [...interpreters, { reference: `Practitioner/${a.interpreterId}`, display: a.interpreterName }],
    issued: new Date().toISOString(),
  });
}

// ─── Patient chart ─────────────────────────────────────────────────────────

export interface PatientReport {
  report: DiagnosticReport;
  observations: Observation[];
}

export async function loadPatientReports(medplum: MedplumClient, patientId: string): Promise<PatientReport[]> {
  const bundle: Bundle = await medplum.search(
    'DiagnosticReport',
    { subject: `Patient/${patientId}`, _include: 'DiagnosticReport:result', _sort: '-_lastUpdated', _count: '50' },
    { cache: 'reload' },
  );
  const all = (bundle.entry ?? []).map((e) => e.resource).filter(Boolean) as Resource[];
  const obs = new Map(all.filter((r): r is Observation => r.resourceType === 'Observation').map((o) => [`Observation/${o.id}`, o]));
  return all
    .filter((r): r is DiagnosticReport => r.resourceType === 'DiagnosticReport')
    .map((report) => ({ report, observations: (report.result ?? []).map((r) => obs.get(r.reference ?? '')).filter((o): o is Observation => !!o) }));
}

export function reportKind(dr: DiagnosticReport): DiagKind {
  return dr.category?.some((c) => c.coding?.some((x) => x.code === 'RAD')) ? 'imaging' : 'laboratory';
}
