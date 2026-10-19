/**
 * Patient profile data model — demographics, ABHA identifiers, social
 * history / diet, allergies, diet orders and vital signs. Pure builders,
 * validators and save helpers shared by PatientDemographics.tsx,
 * PatientLifestyle.tsx, PatientAllergies.tsx, PatientVitals.tsx and
 * NewPatient.tsx, and imported verbatim by
 * scripts/verify/verify-patient-profile.ts so the live check exercises the
 * exact same FHIR shapes the UI writes (this file therefore has NO runtime
 * imports — only `import type` — so Node can load it with type stripping).
 *
 * Terminology, and where each code came from:
 * - ABHA number: Patient.identifier with system `https://healthid.ndhm.gov.in`
 *   and value formatted XX-XXXX-XXXX-XXXX — exactly as in the NRCeS ABDM FHIR
 *   IG v6.5.0 example Patient/example-01 (nrces.in/ndhm/fhir/r4). Type coding
 *   `HIN` ("Health ID issued by NDHM", 14-digit) from the IG's CodeSystem
 *   https://nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-identifier-type-code.
 * - ABHA address (e.g. name@abdm / name@sbx): Known gap, stated plainly — the
 *   NRCeS IG Patient profile defines NO identifier system for the ABHA
 *   address. We use a clearly-named PLACEHOLDER system
 *   `https://hins.example/identifiers/abha-address` with the IG's type code
 *   `ABHA` ("Ayushman Bharat Health Account (ABHA) ID", defined as the
 *   self-declared account identifier). Swap the system when ABDM/NRCeS
 *   publishes one.
 * - ABHA format checks are format-only (14 digits; address local-part 8–18
 *   chars, alphanumeric with at most one '.' or '_' not at either end, domain
 *   @abdm or @sbx). No checksum is applied (we could not confirm ABDM uses
 *   one) and nothing here proves the ABHA exists — real verification is ABDM
 *   M1 APIs, which need sandbox client credentials the hospital must register
 *   for. The UI shows a disabled "Verify with ABDM" button saying exactly that.
 * - Smoking status: LOINC 72166-2 with SNOMED CT answers copied from the HL7
 *   US Core STU3.1.1 value set us-core-observation-smokingstatus (confirmed
 *   at hl7.org/fhir/us/core/STU3.1.1).
 * - Vitals: LOINC codes + UCUM units per the FHIR R4 vital-signs profiles
 *   (hl7.org/fhir/R4/observation-vitalsigns.html). SpO2 carries both 2708-6
 *   (required by the R4 oxygensat profile) and 59408-5 (pulse oximetry).
 * - Blood group: LOINC 882-1 "ABO and Rh group [Type] in Blood"; the VALUE is
 *   free text (e.g. "B+") — Known gap, stated plainly: no SNOMED answer codes
 *   are attached because we did not confirm them from an authoritative source.
 * - Occupation: LOINC 11341-5 "History of Occupation" with a free-text value.
 * - Alcohol use, diet preference, meal pattern, physical activity, diet-order
 *   types: LOCAL codes under https://hins.example/fhir/... with display text.
 *   Known gap, stated plainly: no licensed/confirmed terminology mapping yet
 *   (never fabricate codes).
 * - Marital status: HL7 v3-MaritalStatus; unknown via v3-NullFlavor UNK.
 * - Preferred language: BCP-47 (urn:ietf:bcp:47).
 * - Emergency contact: Patient.contact.relationship = v2-0131 "C" (Emergency
 *   Contact) plus a free-text relationship (spouse, mother, …).
 */
import type {
  AllergyIntolerance,
  CodeableConcept,
  Coding,
  NutritionOrder,
  Observation,
  Patient,
  Practitioner,
  PractitionerRole,
  Reference,
} from '@medplum/fhirtypes';

/** Who performed/ordered/recorded something. */
export type StaffRef = Reference<Practitioner | PractitionerRole>;
import type { MedplumClient } from '@medplum/core';

// ───────────────────────────── systems ─────────────────────────────

export const LOINC = 'http://loinc.org';
export const SNOMED = 'http://snomed.info/sct';
export const UCUM = 'http://unitsofmeasure.org';
export const OBS_CATEGORY = 'http://terminology.hl7.org/CodeSystem/observation-category';

export const ABHA_NUMBER_SYSTEM = 'https://healthid.ndhm.gov.in';
/** PLACEHOLDER — see header. */
export const ABHA_ADDRESS_SYSTEM = 'https://hins.example/identifiers/abha-address';
export const NDHM_IDENTIFIER_TYPE = 'https://nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-identifier-type-code';

export const LIFESTYLE_SYSTEM = 'https://hins.example/fhir/CodeSystem/social-history';
export const LIFESTYLE_VALUE_SYSTEM = 'https://hins.example/fhir/CodeSystem/social-history-answer';
export const DIET_ORDER_SYSTEM = 'https://hins.example/fhir/CodeSystem/diet-order-type';

const MARITAL_SYSTEM = 'http://terminology.hl7.org/CodeSystem/v3-MaritalStatus';
const NULL_FLAVOR = 'http://terminology.hl7.org/CodeSystem/v3-NullFlavor';
const CONTACT_ROLE = 'http://terminology.hl7.org/CodeSystem/v2-0131';
const BCP47 = 'urn:ietf:bcp:47';
const ALLERGY_CLINICAL = 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical';
const ALLERGY_VERIFICATION = 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification';

// ───────────────────────────── option lists ─────────────────────────────

export const MARITAL_OPTIONS = [
  { value: 'S', label: 'Never married' },
  { value: 'M', label: 'Married' },
  { value: 'D', label: 'Divorced' },
  { value: 'W', label: 'Widowed' },
  { value: 'L', label: 'Legally separated' },
  { value: 'UNK', label: 'Unknown' },
];

export const LANGUAGE_OPTIONS = [
  { value: 'en', label: 'English' },
  { value: 'hi', label: 'Hindi' },
  { value: 'bn', label: 'Bengali' },
  { value: 'te', label: 'Telugu' },
  { value: 'mr', label: 'Marathi' },
  { value: 'ta', label: 'Tamil' },
  { value: 'ur', label: 'Urdu' },
  { value: 'gu', label: 'Gujarati' },
  { value: 'kn', label: 'Kannada' },
  { value: 'ml', label: 'Malayalam' },
  { value: 'or', label: 'Odia' },
  { value: 'pa', label: 'Punjabi' },
  { value: 'as', label: 'Assamese' },
];

export const INDIAN_STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana',
  'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur',
  'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana',
  'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal', 'Andaman and Nicobar Islands', 'Chandigarh',
  'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Jammu and Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry',
];

export const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

export const RELATIONSHIPS = ['Spouse', 'Mother', 'Father', 'Son', 'Daughter', 'Brother', 'Sister', 'Guardian', 'Friend', 'Other'];

// ───────────────────────────── validators ─────────────────────────────

/** Returns the canonical XX-XXXX-XXXX-XXXX form, or undefined if not 14 digits. */
export function normalizeAbhaNumber(raw: string): string | undefined {
  const digits = raw.replace(/[\s-]/g, '');
  if (!/^\d{14}$/.test(digits)) return undefined;
  return `${digits.slice(0, 2)}-${digits.slice(2, 6)}-${digits.slice(6, 10)}-${digits.slice(10)}`;
}

export function isValidAbhaAddress(raw: string): boolean {
  return /^(?=[a-z0-9._]{8,18}@)[a-z0-9]+(?:[._][a-z0-9]+)?@(abdm|sbx)$/i.test(raw.trim());
}

export function isValidPhone(raw: string): boolean {
  const s = raw.replace(/[\s()-]/g, '');
  if (/^(\+91|0)?[6-9]\d{9}$/.test(s)) return true; // Indian mobile
  return /^\+(?!91)\d{7,15}$/.test(s); // other E.164
}

export const isValidEmail = (raw: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.trim());
export const isValidPin = (raw: string): boolean => /^[1-9]\d{5}$/.test(raw.trim());

// ───────────────────────────── demographics ─────────────────────────────

export interface DemographicsForm {
  prefix: string;
  givenFirst: string;
  givenMiddle: string;
  family: string;
  gender: string;
  birthDate: string;
  maritalStatus: string;
  language: string;
  phone: string;
  email: string;
  addrLine: string;
  city: string;
  district: string;
  state: string;
  pin: string;
  country: string;
  ecName: string;
  ecRelationship: string;
  ecPhone: string;
  occupation: string;
  bloodGroup: string;
  abhaNumber: string;
  abhaAddress: string;
}

export const EMPTY_DEMOGRAPHICS: DemographicsForm = {
  prefix: '', givenFirst: '', givenMiddle: '', family: '', gender: '', birthDate: '', maritalStatus: '',
  language: '', phone: '', email: '', addrLine: '', city: '', district: '', state: '', pin: '', country: 'IN',
  ecName: '', ecRelationship: '', ecPhone: '', occupation: '', bloodGroup: '', abhaNumber: '', abhaAddress: '',
};

export type DemographicsErrors = Partial<Record<keyof DemographicsForm, string>>;

export function validateDemographics(f: DemographicsForm, today = new Date().toISOString().slice(0, 10)): DemographicsErrors {
  const e: DemographicsErrors = {};
  if (!f.givenFirst.trim()) e.givenFirst = 'Required';
  if (!f.family.trim()) e.family = 'Required';
  if (!f.birthDate) e.birthDate = 'Required';
  else if (f.birthDate > today) e.birthDate = 'Cannot be in the future';
  if (f.phone.trim() && !isValidPhone(f.phone)) e.phone = 'Indian mobile (10 digits, starts 6–9) or +country number';
  if (f.email.trim() && !isValidEmail(f.email)) e.email = 'Not a valid email';
  if (f.pin.trim() && (f.country || 'IN') === 'IN' && !isValidPin(f.pin)) e.pin = '6 digits, not starting with 0';
  if (f.ecPhone.trim() && !isValidPhone(f.ecPhone)) e.ecPhone = 'Not a valid phone number';
  if ((f.ecPhone.trim() || f.ecRelationship) && !f.ecName.trim()) e.ecName = 'Name required for an emergency contact';
  if (f.abhaNumber.trim() && !normalizeAbhaNumber(f.abhaNumber)) e.abhaNumber = '14 digits, XX-XXXX-XXXX-XXXX';
  if (f.abhaAddress.trim() && !isValidAbhaAddress(f.abhaAddress))
    e.abhaAddress = 'e.g. asha.verma@abdm (8–18 chars, letters/digits, one . or _ max; @abdm or @sbx)';
  return e;
}

function isEmergencyContact(c: NonNullable<Patient['contact']>[number]): boolean {
  return !!c.relationship?.some((r) => r.coding?.some((x) => x.system === CONTACT_ROLE && x.code === 'C'));
}

export function patientToForm(p: Patient | undefined): DemographicsForm {
  if (!p) return { ...EMPTY_DEMOGRAPHICS };
  const name = p.name?.find((n) => n.use === 'official') ?? p.name?.[0];
  const addr = p.address?.find((a) => a.use === 'home') ?? p.address?.[0];
  const ec = p.contact?.find(isEmergencyContact);
  const pref = p.communication?.find((c) => c.preferred) ?? p.communication?.[0];
  const ms = p.maritalStatus?.coding?.[0]?.code ?? '';
  return {
    prefix: name?.prefix?.[0] ?? '',
    givenFirst: name?.given?.[0] ?? '',
    givenMiddle: name?.given?.slice(1).join(' ') ?? '',
    family: name?.family ?? '',
    gender: p.gender ?? '',
    birthDate: p.birthDate ?? '',
    maritalStatus: ms,
    language: pref?.language?.coding?.find((c) => c.system === BCP47)?.code ?? '',
    phone: p.telecom?.find((t) => t.system === 'phone')?.value ?? '',
    email: p.telecom?.find((t) => t.system === 'email')?.value ?? '',
    addrLine: addr?.line?.join(', ') ?? '',
    city: addr?.city ?? '',
    district: addr?.district ?? '',
    state: addr?.state ?? '',
    pin: addr?.postalCode ?? '',
    country: addr?.country ?? 'IN',
    ecName: ec?.name?.text ?? [ec?.name?.given?.join(' '), ec?.name?.family].filter(Boolean).join(' '),
    ecRelationship: ec?.relationship?.find((r) => !r.coding?.length)?.text ?? '',
    ecPhone: ec?.telecom?.find((t) => t.system === 'phone')?.value ?? '',
    occupation: '',
    bloodGroup: '',
    abhaNumber: p.identifier?.find((i) => i.system === ABHA_NUMBER_SYSTEM)?.value ?? '',
    abhaAddress: p.identifier?.find((i) => i.system === ABHA_ADDRESS_SYSTEM)?.value ?? '',
  };
}

const t = (s: string): string | undefined => s.trim() || undefined;

function upsertTelecom(
  list: NonNullable<Patient['telecom']>,
  system: 'phone' | 'email',
  value: string | undefined,
): NonNullable<Patient['telecom']> {
  const idx = list.findIndex((x) => x.system === system);
  if (!value) return idx === -1 ? list : list.filter((_, i) => i !== idx);
  if (idx === -1) return [...list, { system, value, use: system === 'phone' ? 'mobile' : 'home' }];
  return list.map((x, i) => (i === idx ? { ...x, value } : x));
}

function upsertIdentifier(
  list: NonNullable<Patient['identifier']>,
  system: string,
  typeCode: string,
  typeDisplay: string,
  value: string | undefined,
): NonNullable<Patient['identifier']> {
  const rest = list.filter((i) => i.system !== system);
  if (!value) return rest;
  return [...rest, { type: { coding: [{ system: NDHM_IDENTIFIER_TYPE, code: typeCode, display: typeDisplay }] }, system, value }];
}

/**
 * Applies the form onto a copy of the existing Patient. Fields the form does
 * not manage (MRN, other names/telecoms/contacts, links…) are preserved.
 */
export function applyDemographics(existing: Patient, f: DemographicsForm): Patient {
  const name = {
    ...(existing.name?.find((n) => n.use === 'official') ?? existing.name?.[0] ?? {}),
    use: 'official' as const,
    prefix: t(f.prefix) ? [f.prefix.trim()] : undefined,
    given: [f.givenFirst.trim(), ...f.givenMiddle.trim().split(/\s+/).filter(Boolean)],
    family: f.family.trim(),
  };
  delete (name as { text?: string }).text;
  const otherNames = (existing.name ?? []).filter((n, i) => !(n.use === 'official' || (i === 0 && !existing.name?.some((x) => x.use === 'official'))));

  let telecom = upsertTelecom(existing.telecom ?? [], 'phone', t(f.phone));
  telecom = upsertTelecom(telecom, 'email', t(f.email));

  const hasAddr = [f.addrLine, f.city, f.district, f.state, f.pin].some((s) => s.trim());
  const oldAddr = existing.address?.find((a) => a.use === 'home') ?? existing.address?.[0];
  const otherAddr = (existing.address ?? []).filter((a) => a !== oldAddr);
  const address = hasAddr
    ? [
        {
          ...(oldAddr ?? {}),
          use: 'home' as const,
          line: t(f.addrLine) ? f.addrLine.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
          city: t(f.city),
          district: t(f.district),
          state: t(f.state),
          postalCode: t(f.pin),
          country: t(f.country) ?? 'IN',
        },
        ...otherAddr,
      ]
    : otherAddr;

  const otherContacts = (existing.contact ?? []).filter((c) => !isEmergencyContact(c));
  const contact = t(f.ecName)
    ? [
        {
          relationship: [
            { coding: [{ system: CONTACT_ROLE, code: 'C', display: 'Emergency Contact' }] },
            ...(t(f.ecRelationship) ? [{ text: f.ecRelationship.trim() }] : []),
          ],
          name: { text: f.ecName.trim() },
          telecom: t(f.ecPhone) ? [{ system: 'phone' as const, value: f.ecPhone.trim() }] : undefined,
        },
        ...otherContacts,
      ]
    : otherContacts;

  const lang = LANGUAGE_OPTIONS.find((l) => l.value === f.language);
  const otherComm = (existing.communication ?? []).filter(
    (c) => !c.language?.coding?.some((x) => x.system === BCP47 && x.code === f.language),
  ).map((c) => ({ ...c, preferred: undefined }));
  const communication = lang
    ? [{ language: { coding: [{ system: BCP47, code: lang.value, display: lang.label }], text: lang.label }, preferred: true }, ...otherComm]
    : existing.communication;

  const ms = MARITAL_OPTIONS.find((m) => m.value === f.maritalStatus);
  const maritalStatus: CodeableConcept | undefined = ms
    ? { coding: [{ system: ms.value === 'UNK' ? NULL_FLAVOR : MARITAL_SYSTEM, code: ms.value, display: ms.label }], text: ms.label }
    : undefined;

  let identifier = upsertIdentifier(existing.identifier ?? [], ABHA_NUMBER_SYSTEM, 'HIN', 'Health ID issued by NDHM',
    t(f.abhaNumber) ? normalizeAbhaNumber(f.abhaNumber) : undefined);
  identifier = upsertIdentifier(identifier, ABHA_ADDRESS_SYSTEM, 'ABHA', 'Ayushman Bharat Health Account (ABHA) ID',
    t(f.abhaAddress)?.toLowerCase());

  const out: Patient = {
    ...existing,
    name: [name, ...otherNames],
    gender: (f.gender || undefined) as Patient['gender'],
    birthDate: f.birthDate || undefined,
    maritalStatus,
    communication: communication?.length ? communication : undefined,
    telecom: telecom.length ? telecom : undefined,
    address: address.length ? address : undefined,
    contact: contact.length ? contact : undefined,
    identifier: identifier.length ? identifier : undefined,
  };
  for (const k of Object.keys(out) as (keyof Patient)[]) if (out[k] === undefined) delete out[k];
  return out;
}

// ───────────────────────────── generic observation helpers ─────────────────────────────

export const BLOOD_GROUP_CODE: Coding = { system: LOINC, code: '882-1', display: 'ABO and Rh group [Type] in Blood' };
export const OCCUPATION_CODE: Coding = { system: LOINC, code: '11341-5', display: 'History of Occupation' };

const subj = (patientId: string): Reference<Patient> => ({ reference: `Patient/${patientId}` });

/** Latest non-entered-in-error Observation for a code (fresh read — bypasses client cache). */
export async function latestObservation(
  medplum: MedplumClient,
  patientId: string,
  code: Coding,
): Promise<Observation | undefined> {
  const list = await medplum.searchResources(
    'Observation',
    { subject: `Patient/${patientId}`, code: `${code.system}|${code.code}`, 'status:not': 'entered-in-error', _sort: '-date', _count: 1 },
    { cache: 'reload' },
  );
  return list[0];
}

export const obsText = (o: Observation | undefined): string =>
  o?.valueCodeableConcept?.text ?? o?.valueCodeableConcept?.coding?.[0]?.display ?? o?.valueString ?? '';

export function buildTextObservation(
  patientId: string,
  code: Coding,
  value: string,
  category: 'social-history' | 'laboratory' | undefined,
  performer?: StaffRef,
): Observation {
  return {
    resourceType: 'Observation',
    status: 'final',
    category: category ? [{ coding: [{ system: OBS_CATEGORY, code: category }] }] : undefined,
    code: { coding: [code], text: code.display },
    subject: subj(patientId),
    effectiveDateTime: new Date().toISOString(),
    performer: performer ? [performer] : undefined,
    valueCodeableConcept: { text: value },
  };
}

/**
 * Saves the full demographics form: updates (or creates) the Patient, then
 * records blood group / occupation as NEW Observations only when the value
 * differs from the latest one on file (history preserved — never overwritten).
 */
export async function saveDemographics(
  medplum: MedplumClient,
  f: DemographicsForm,
  existing: Patient | undefined,
  base: Partial<Patient> = {},
  performer?: StaffRef,
): Promise<Patient> {
  const applied = applyDemographics({ resourceType: 'Patient', ...base, ...(existing ?? {}) } as Patient, f);
  const patient = existing?.id ? await medplum.updateResource(applied) : await medplum.createResource(applied);
  const id = patient.id as string;
  const pairs: [Coding, string, 'laboratory' | 'social-history' | undefined][] = [
    // Blood group deliberately has NO category: a free-text ABO/Rh value would
    // render as an empty numeric result in the Labs tab (LabResultsList).
    [BLOOD_GROUP_CODE, f.bloodGroup.trim(), undefined],
    [OCCUPATION_CODE, f.occupation.trim(), 'social-history'],
  ];
  for (const [code, value, cat] of pairs) {
    if (!value) continue;
    const prev = existing?.id ? await latestObservation(medplum, id, code) : undefined;
    if (obsText(prev) === value) continue;
    await medplum.createResource(buildTextObservation(id, code, value, cat, performer));
  }
  return patient;
}

// ───────────────────────────── social history & diet ─────────────────────────────

export interface LifestyleItem {
  key: string;
  label: string;
  code: Coding;
  answers?: { code: string; display: string; system?: string }[];
  freeText?: boolean;
}

export const SMOKING_ANSWERS = [
  { system: SNOMED, code: '266919005', display: 'Never smoker' },
  { system: SNOMED, code: '8517006', display: 'Former smoker' },
  { system: SNOMED, code: '449868002', display: 'Current every day smoker' },
  { system: SNOMED, code: '428041000124106', display: 'Current some day smoker' },
  { system: SNOMED, code: '428071000124103', display: 'Current Heavy tobacco smoker' },
  { system: SNOMED, code: '428061000124105', display: 'Current Light tobacco smoker' },
  { system: SNOMED, code: '77176002', display: 'Smoker, current status unknown' },
  { system: SNOMED, code: '266927001', display: 'Unknown if ever smoked' },
];

const local = (code: string, display: string): Coding => ({ system: LIFESTYLE_SYSTEM, code, display });

export const LIFESTYLE_ITEMS: LifestyleItem[] = [
  { key: 'smoking', label: 'Smoking status', code: { system: LOINC, code: '72166-2', display: 'Tobacco smoking status' }, answers: SMOKING_ANSWERS },
  {
    key: 'alcohol', label: 'Alcohol use', code: local('alcohol-use', 'Alcohol use'),
    answers: [
      { code: 'never', display: 'Never' }, { code: 'former', display: 'Former drinker' },
      { code: 'occasional', display: 'Occasional / social' }, { code: 'regular', display: 'Regular' },
      { code: 'heavy', display: 'Heavy' },
    ],
  },
  {
    key: 'diet', label: 'Diet preference', code: local('diet-preference', 'Diet preference'),
    answers: [
      { code: 'vegetarian', display: 'Vegetarian' }, { code: 'eggetarian', display: 'Eggetarian' },
      { code: 'non-vegetarian', display: 'Non-vegetarian' }, { code: 'vegan', display: 'Vegan' },
      { code: 'jain', display: 'Jain (no root vegetables)' }, { code: 'other', display: 'Other' },
    ],
  },
  { key: 'meals', label: 'Meal pattern', code: local('meal-pattern', 'Meal pattern'), freeText: true },
  {
    key: 'activity', label: 'Physical activity', code: local('physical-activity', 'Physical activity level'),
    answers: [
      { code: 'sedentary', display: 'Sedentary' }, { code: 'light', display: 'Light' },
      { code: 'moderate', display: 'Moderate' }, { code: 'vigorous', display: 'Vigorous' },
    ],
  },
];

export function buildLifestyleObservation(
  patientId: string,
  item: LifestyleItem,
  answerCode: string | undefined,
  note: string | undefined,
  performer?: StaffRef,
): Observation {
  const ans = item.answers?.find((a) => a.code === answerCode);
  const noteText = note?.trim();
  if (!ans && !noteText) throw new Error(`${item.label}: choose a value or enter text`);
  const value: CodeableConcept = ans
    ? { coding: [{ system: ans.system ?? LIFESTYLE_VALUE_SYSTEM, code: ans.code, display: ans.display }], text: ans.display }
    : { text: noteText };
  return {
    resourceType: 'Observation',
    status: 'final',
    category: [{ coding: [{ system: OBS_CATEGORY, code: 'social-history', display: 'Social History' }] }],
    code: { coding: [item.code], text: item.label },
    subject: subj(patientId),
    effectiveDateTime: new Date().toISOString(),
    performer: performer ? [performer] : undefined,
    valueCodeableConcept: value,
    note: ans && noteText ? [{ text: noteText }] : undefined,
  };
}

// ───────────────────────────── diet orders ─────────────────────────────

export const DIET_TYPES = [
  { code: 'regular', display: 'Regular diet' },
  { code: 'diabetic', display: 'Diabetic diet' },
  { code: 'low-salt', display: 'Low salt diet' },
  { code: 'renal', display: 'Renal diet' },
  { code: 'cardiac', display: 'Cardiac (low fat) diet' },
  { code: 'soft', display: 'Soft diet' },
  { code: 'liquid', display: 'Liquid diet' },
  { code: 'clear-liquid', display: 'Clear liquid diet' },
  { code: 'high-protein', display: 'High protein diet' },
  { code: 'npo', display: 'NPO (nil by mouth)' },
];

export const NUTRITION_ORDER_TRANSITIONS: Record<string, NutritionOrder['status'][]> = {
  active: ['on-hold', 'completed', 'revoked', 'entered-in-error'],
  'on-hold': ['active', 'revoked', 'entered-in-error'],
  draft: ['active', 'revoked', 'entered-in-error'],
};

export function buildNutritionOrder(input: {
  patientId: string;
  dietCodes: string[];
  instruction?: string;
  foodPreference?: string;
  allergyIds?: string[];
  orderer?: StaffRef;
  encounterId?: string;
}): NutritionOrder {
  const types = DIET_TYPES.filter((d) => input.dietCodes.includes(d.code));
  if (!types.length) throw new Error('Choose at least one diet type');
  return {
    resourceType: 'NutritionOrder',
    status: 'active',
    intent: 'order',
    patient: subj(input.patientId),
    encounter: input.encounterId ? { reference: `Encounter/${input.encounterId}` } : undefined,
    dateTime: new Date().toISOString(),
    orderer: input.orderer,
    allergyIntolerance: input.allergyIds?.length ? input.allergyIds.map((id) => ({ reference: `AllergyIntolerance/${id}` })) : undefined,
    foodPreferenceModifier: input.foodPreference ? [{ text: input.foodPreference }] : undefined,
    oralDiet: {
      type: types.map((d) => ({ coding: [{ system: DIET_ORDER_SYSTEM, code: d.code, display: d.display }], text: d.display })),
      instruction: input.instruction?.trim() || undefined,
    },
  };
}

// ───────────────────────────── allergies ─────────────────────────────

export type AllergyCategory = 'food' | 'medication' | 'environment' | 'biologic';

export function buildAllergy(input: {
  patientId: string;
  substance: string;
  type: 'allergy' | 'intolerance';
  category: AllergyCategory;
  criticality: 'low' | 'high' | 'unable-to-assess';
  verification: 'unconfirmed' | 'confirmed';
  reaction?: string;
  severity?: 'mild' | 'moderate' | 'severe';
  note?: string;
  recorder?: StaffRef;
}): AllergyIntolerance {
  if (!input.substance.trim()) throw new Error('Substance is required');
  return {
    resourceType: 'AllergyIntolerance',
    clinicalStatus: { coding: [{ system: ALLERGY_CLINICAL, code: 'active', display: 'Active' }] },
    verificationStatus: { coding: [{ system: ALLERGY_VERIFICATION, code: input.verification }] },
    type: input.type,
    category: [input.category],
    criticality: input.criticality,
    code: { text: input.substance.trim() },
    patient: subj(input.patientId),
    recordedDate: new Date().toISOString(),
    recorder: input.recorder,
    reaction: input.reaction?.trim()
      ? [{ manifestation: [{ text: input.reaction.trim() }], severity: input.severity }]
      : undefined,
    note: input.note?.trim() ? [{ text: input.note.trim() }] : undefined,
  };
}

/**
 * Non-destructive retraction. FHIR invariant ait-2: clinicalStatus SHALL NOT
 * be present when verificationStatus is entered-in-error, so it is removed
 * (the prior value stays in the resource's version history).
 */
export function markAllergyEnteredInError(a: AllergyIntolerance): AllergyIntolerance {
  const out: AllergyIntolerance = {
    ...a,
    verificationStatus: { coding: [{ system: ALLERGY_VERIFICATION, code: 'entered-in-error', display: 'Entered in Error' }] },
  };
  delete out.clinicalStatus;
  return out;
}

export const allergyVerification = (a: AllergyIntolerance): string => a.verificationStatus?.coding?.[0]?.code ?? 'unconfirmed';
export const allergyClinical = (a: AllergyIntolerance): string => a.clinicalStatus?.coding?.[0]?.code ?? '—';

// ───────────────────────────── vitals ─────────────────────────────

export interface VitalsInput {
  systolic?: number;
  diastolic?: number;
  heartRate?: number;
  respRate?: number;
  tempC?: number;
  spo2?: number;
  weightKg?: number;
  heightCm?: number;
}

interface VitalDef {
  key: keyof VitalsInput | 'bp' | 'bmi';
  label: string;
  coding: Coding[];
  unit?: string;
  ucum?: string;
  min?: number;
  max?: number;
}

const L = (code: string, display: string): Coding => ({ system: LOINC, code, display });

export const VITAL_DEFS: VitalDef[] = [
  { key: 'bp', label: 'Blood pressure', coding: [L('85354-9', 'Blood pressure panel with all children optional')], unit: 'mmHg', ucum: 'mm[Hg]' },
  { key: 'heartRate', label: 'Heart rate', coding: [L('8867-4', 'Heart rate')], unit: '/min', ucum: '/min', min: 20, max: 300 },
  { key: 'respRate', label: 'Respiratory rate', coding: [L('9279-1', 'Respiratory rate')], unit: '/min', ucum: '/min', min: 4, max: 80 },
  { key: 'tempC', label: 'Body temperature', coding: [L('8310-5', 'Body temperature')], unit: '°C', ucum: 'Cel', min: 30, max: 45 },
  {
    key: 'spo2', label: 'SpO₂',
    coding: [L('2708-6', 'Oxygen saturation in Arterial blood'), L('59408-5', 'Oxygen saturation in Arterial blood by Pulse oximetry')],
    unit: '%', ucum: '%', min: 50, max: 100,
  },
  { key: 'weightKg', label: 'Body weight', coding: [L('29463-7', 'Body weight')], unit: 'kg', ucum: 'kg', min: 0.3, max: 400 },
  { key: 'heightCm', label: 'Body height', coding: [L('8302-2', 'Body height')], unit: 'cm', ucum: 'cm', min: 20, max: 260 },
  { key: 'bmi', label: 'BMI', coding: [L('39156-5', 'Body mass index (BMI) [Ratio]')], unit: 'kg/m²', ucum: 'kg/m2' },
];

export const SYSTOLIC = L('8480-6', 'Systolic blood pressure');
export const DIASTOLIC = L('8462-4', 'Diastolic blood pressure');
export const VITAL_LOINC_CODES = ['85354-9', '8867-4', '9279-1', '8310-5', '2708-6', '29463-7', '8302-2', '39156-5'];

export function computeBmi(weightKg: number, heightCm: number): number {
  const m = heightCm / 100;
  return Math.round((weightKg / (m * m)) * 10) / 10;
}

export function validateVitals(v: VitalsInput): string[] {
  const errs: string[] = [];
  if ((v.systolic === undefined) !== (v.diastolic === undefined)) errs.push('Blood pressure needs both systolic and diastolic');
  if (v.systolic !== undefined && v.diastolic !== undefined) {
    if (v.systolic < 40 || v.systolic > 300 || v.diastolic < 20 || v.diastolic > 200) errs.push('Blood pressure out of plausible range');
    if (v.diastolic >= v.systolic) errs.push('Diastolic must be lower than systolic');
  }
  for (const d of VITAL_DEFS) {
    if (d.min === undefined) continue;
    const val = v[d.key as keyof VitalsInput];
    if (val !== undefined && (val < d.min || val > (d.max as number))) errs.push(`${d.label} out of plausible range (${d.min}–${d.max} ${d.unit})`);
  }
  if (Object.values(v).every((x) => x === undefined)) errs.push('Enter at least one vital sign');
  return errs;
}

const qty = (value: number, unit: string, ucum: string) => ({ value, unit, system: UCUM, code: ucum });

/**
 * One Observation per vital (FHIR R4 vital-signs profiles), all sharing the
 * same effectiveDateTime so the trend table groups them as one reading. BMI
 * is computed when weight is entered and a height is available (this
 * reading's, else `fallbackHeightCm` — the latest on file).
 */
export function buildVitalsObservations(
  patientId: string,
  v: VitalsInput,
  opts: { effective?: string; performer?: StaffRef; encounterId?: string; fallbackHeightCm?: number } = {},
): Observation[] {
  const effectiveDateTime = opts.effective ?? new Date().toISOString();
  const base = (def: VitalDef): Observation => ({
    resourceType: 'Observation',
    meta: { profile: ['http://hl7.org/fhir/StructureDefinition/vitalsigns'] },
    status: 'final',
    category: [{ coding: [{ system: OBS_CATEGORY, code: 'vital-signs', display: 'Vital Signs' }], text: 'Vital Signs' }],
    code: { coding: def.coding, text: def.label },
    subject: subj(patientId),
    encounter: opts.encounterId ? { reference: `Encounter/${opts.encounterId}` } : undefined,
    effectiveDateTime,
    performer: opts.performer ? [opts.performer] : undefined,
  });
  const out: Observation[] = [];
  for (const def of VITAL_DEFS) {
    if (def.key === 'bp') {
      if (v.systolic === undefined || v.diastolic === undefined) continue;
      out.push({
        ...base(def),
        component: [
          { code: { coding: [SYSTOLIC] }, valueQuantity: qty(v.systolic, 'mmHg', 'mm[Hg]') },
          { code: { coding: [DIASTOLIC] }, valueQuantity: qty(v.diastolic, 'mmHg', 'mm[Hg]') },
        ],
      });
    } else if (def.key === 'bmi') {
      const h = v.heightCm ?? opts.fallbackHeightCm;
      if (v.weightKg === undefined || !h) continue;
      out.push({ ...base(def), valueQuantity: qty(computeBmi(v.weightKg, h), def.unit as string, def.ucum as string) });
    } else {
      const val = v[def.key];
      if (val === undefined) continue;
      out.push({ ...base(def), valueQuantity: qty(val, def.unit as string, def.ucum as string) });
    }
  }
  return out;
}

/** Key a vital Observation back to its VITAL_DEFS entry. */
export function vitalKey(o: Observation): VitalDef['key'] | undefined {
  const codes = o.code?.coding?.filter((c) => c.system === LOINC).map((c) => c.code) ?? [];
  return VITAL_DEFS.find((d) => d.coding.some((c) => codes.includes(c.code)))?.key;
}

export function formatVital(o: Observation): string {
  if (vitalKey(o) === 'bp') {
    const s = o.component?.find((c) => c.code?.coding?.some((x) => x.code === '8480-6'))?.valueQuantity?.value;
    const d = o.component?.find((c) => c.code?.coding?.some((x) => x.code === '8462-4'))?.valueQuantity?.value;
    return s !== undefined && d !== undefined ? `${s}/${d}` : '—';
  }
  return o.valueQuantity?.value !== undefined ? String(o.valueQuantity.value) : '—';
}
