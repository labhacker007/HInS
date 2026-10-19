import { useEffect, useState } from 'react';
import { Stack, Group, Title, Paper, TextInput, Select, Button, Text, NumberInput, SegmentedControl, Badge } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { Observation, Organization, Patient } from '@medplum/fhirtypes';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import { formatHumanName, formatPatientMrn } from '../lib/fhirFormat.js';
import { DEPARTMENTS } from '../lib/hospital.js';
import {
  ACUITY_LEVELS,
  VITALS,
  buildTriageEncounter,
  buildTriageObservations,
  type VitalKey,
  type VitalValues,
} from '../lib/clinical.js';

/** Departments a patient can be triaged INTO (clinical intake points). */
export const TRIAGE_DEPARTMENTS = ['emergency', 'general-medicine', 'cardiology', 'pediatrics'] as const;

/**
 * Triage intake: arrival, chief complaint, vitals (LOINC), pain 0-10,
 * ESI-style acuity 1-5, department. Writes one Encounter (status
 * 'triaged', priority = acuity) and then one Observation per recorded
 * value, sequentially. Medplum transaction Bundles aren't atomic here, so
 * we don't pretend: if an Observation write fails after the Encounter
 * was created, the Encounter is flipped to 'entered-in-error' (status
 * transition, never delete) and the error shown — the nurse re-submits.
 */
export function TriageForm({ depts, onCreated }: { depts: Record<string, Organization>; onCreated: () => void }) {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const [patientQuery, setPatientQuery] = useState('');
  const [patientResults, setPatientResults] = useState<Patient[] | undefined>();
  const [patient, setPatient] = useState<Patient | undefined>();
  const [arrival, setArrival] = useState(() => toLocalInput(new Date()));
  const [complaint, setComplaint] = useState('');
  const [dept, setDept] = useState<string>('emergency');
  const [acuity, setAcuity] = useState<string>('3');
  const [pain, setPain] = useState<number | string>('');
  const [vitals, setVitals] = useState<Record<VitalKey, number | string>>({
    systolic: '',
    diastolic: '',
    heartRate: '',
    respRate: '',
    temperature: '',
    spo2: '',
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (patient || !patientQuery.trim()) {
      setPatientResults(undefined);
      return;
    }
    const t = setTimeout(() => {
      medplum.searchResources('Patient', { name: patientQuery, _count: 10 }).then(setPatientResults);
    }, 250);
    return () => clearTimeout(t);
  }, [medplum, patientQuery, patient]);

  const deptOrg = depts[dept];
  const canSave = !!patient?.id && !!complaint.trim() && !!deptOrg?.id;

  async function handleSave() {
    if (!patient?.id || !deptOrg?.id) return;
    setSaving(true);
    const arrivalIso = new Date(arrival).toISOString();
    const patientRef = { reference: `Patient/${patient.id}`, display: formatHumanName(patient.name) };
    const nurseRef = profile?.id ? { reference: `${profile.resourceType}/${profile.id}`, display: formatHumanName(profile.name as any) } : undefined;
    let encounterId: string | undefined;
    try {
      const enc = await medplum.createResource(
        buildTriageEncounter({
          patient: patientRef,
          department: { reference: `Organization/${deptOrg.id}`, display: deptOrg.name },
          departmentCode: dept,
          arrival: arrivalIso,
          chiefComplaint: complaint.trim(),
          acuity: Number(acuity),
          triagedBy: nurseRef,
        })
      );
      encounterId = enc.id;
      const vals: VitalValues = {};
      for (const v of VITALS) vals[v.key] = vitals[v.key] === '' ? undefined : Number(vitals[v.key]);
      const obs = buildTriageObservations({
        patient: patientRef,
        encounter: { reference: `Encounter/${enc.id}` },
        performer: nurseRef,
        effective: new Date().toISOString(),
        vitals: vals,
        pain: pain === '' ? undefined : Number(pain),
        acuity: Number(acuity),
      });
      const created: Observation[] = [];
      for (const o of obs) created.push(await medplum.createResource(o));
      notifications.show({ message: `Triaged — acuity ${acuity}, ${created.length} observations recorded`, color: 'green' });
      setPatient(undefined);
      setPatientQuery('');
      setComplaint('');
      setPain('');
      setVitals({ systolic: '', diastolic: '', heartRate: '', respRate: '', temperature: '', spo2: '' });
      setArrival(toLocalInput(new Date()));
      onCreated();
    } catch (err) {
      if (encounterId) {
        try {
          const fresh = await medplum.readResource('Encounter', encounterId, { cache: 'reload' });
          await medplum.updateResource({ ...fresh, status: 'entered-in-error' });
        } catch {
          /* best effort; the error below is what matters */
        }
      }
      notifications.show({ message: `Triage not saved: ${String(err)}`, color: 'red' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Paper withBorder p="md">
      <Stack gap="sm">
        <Title order={5}>New triage</Title>
        {patient ? (
          <Group justify="space-between">
            <Text>
              Patient:{' '}
              <Text span fw={600}>
                {formatHumanName(patient.name)}
              </Text>{' '}
              <Text span c="dimmed" size="sm">
                (MRN {formatPatientMrn(patient)})
              </Text>
            </Text>
            <Button size="xs" variant="subtle" onClick={() => setPatient(undefined)}>
              Change patient
            </Button>
          </Group>
        ) : (
          <Stack gap={4}>
            <TextInput
              label="Patient"
              placeholder="Search by name…"
              value={patientQuery}
              onChange={(e) => setPatientQuery(e.currentTarget.value)}
              maw={360}
            />
            {patientResults !== undefined && (
              <Paper withBorder p="xs" maw={360}>
                {patientResults.length === 0 ? (
                  <Text size="sm" c="dimmed">
                    No matches — register the patient first (Patients → New patient).
                  </Text>
                ) : (
                  <Stack gap={2}>
                    {patientResults.map((p) => (
                      <Text key={p.id} size="sm" style={{ cursor: 'pointer' }} onClick={() => setPatient(p)}>
                        {formatHumanName(p.name)}{' '}
                        <Text span c="dimmed">
                          ({formatPatientMrn(p)})
                        </Text>
                      </Text>
                    ))}
                  </Stack>
                )}
              </Paper>
            )}
          </Stack>
        )}

        <Group grow align="flex-start">
          <TextInput label="Arrival time" type="datetime-local" value={arrival} onChange={(e) => setArrival(e.currentTarget.value)} />
          <Select
            label="Department"
            data={TRIAGE_DEPARTMENTS.map((code) => ({
              value: code,
              label: DEPARTMENTS.find((d) => d.code === code)?.name ?? code,
              disabled: !depts[code],
            }))}
            value={dept}
            onChange={(v) => setDept(v ?? 'emergency')}
            allowDeselect={false}
          />
        </Group>
        <TextInput
          label="Chief complaint"
          placeholder="In the patient's words, e.g. 'chest pain since 2 hours'"
          value={complaint}
          onChange={(e) => setComplaint(e.currentTarget.value)}
          required
        />

        <Text size="sm" fw={500}>
          Vitals
        </Text>
        <Group grow>
          {VITALS.map((v) => (
            <NumberInput
              key={v.key}
              label={`${shortLabel(v.key)} (${v.unit})`}
              title={`LOINC ${v.code} — ${v.display}`}
              value={vitals[v.key]}
              onChange={(val) => setVitals((prev) => ({ ...prev, [v.key]: val }))}
              decimalScale={v.key === 'temperature' ? 1 : 0}
              min={0}
              hideControls
            />
          ))}
        </Group>
        <Group align="flex-end">
          <NumberInput label="Pain (0-10)" value={pain} onChange={setPain} min={0} max={10} clampBehavior="strict" w={120} />
          <Stack gap={4}>
            <Text size="sm" fw={500}>
              Acuity (ESI-style, nurse-assigned)
            </Text>
            <SegmentedControl
              value={acuity}
              onChange={setAcuity}
              data={ACUITY_LEVELS.map((a) => ({ value: String(a.level), label: a.label }))}
            />
          </Stack>
          <Badge color={ACUITY_LEVELS.find((a) => String(a.level) === acuity)?.color} size="lg">
            ESI {acuity}
          </Badge>
        </Group>
        <Group justify="flex-end">
          <Button loading={saving} disabled={!canSave} onClick={handleSave}>
            Save triage &amp; add to queue
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}

function shortLabel(k: VitalKey): string {
  return { systolic: 'BP sys', diastolic: 'BP dia', heartRate: 'HR', respRate: 'RR', temperature: 'Temp', spo2: 'SpO₂' }[k];
}

function toLocalInput(d: Date): string {
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
}
