import type { HumanName, Patient } from '@medplum/fhirtypes';

export function formatHumanName(names: HumanName[] | undefined): string {
  const n = names?.[0];
  if (!n) return '(no name on file)';
  return [n.given?.join(' '), n.family].filter(Boolean).join(' ') || '(no name on file)';
}

/** The MRN is whichever identifier is tagged with the hins-mrn system (see NewPatient.tsx). */
export const MRN_SYSTEM = 'https://hins.example/identifiers/mrn';

export function formatPatientMrn(patient: Patient): string {
  return patient.identifier?.find((id) => id.system === MRN_SYSTEM)?.value ?? '—';
}
