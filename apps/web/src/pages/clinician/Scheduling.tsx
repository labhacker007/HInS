import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Stack, Group, Title, Paper, TextInput, Select, Button, Table, Text, Loader, Divider, Badge } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { Appointment, Patient, Practitioner } from '@medplum/fhirtypes';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import { formatHumanName, formatPatientMrn } from '../../lib/fhirFormat.js';
import { DictationTextInput } from '../../components/DictationTextarea.js';

/**
 * Scheduling — docs/PLATFORM_BLUEPRINT.md §16's "fully EHR/EMR" gap
 * ("scheduling, bed/ward management, and full order workflows ... are
 * still unbuilt Phase 01 items"). This is the scheduling slice only —
 * bed/ward management is a separate, larger piece, not attempted here.
 *
 * No new backend service: FHIR's native `Appointment` resource via the
 * existing Medplum instance is the right fit, same pattern as how
 * Encounter/Condition/Observation/MedicationRequest are already used
 * directly from this app (see PatientDetail.tsx). Everything on this
 * page is a direct FHIR call through @medplum/core, no custom API.
 *
 * Non-destructive history convention (same as the rest of this codebase
 * — see VersionedNote.tsx / VersionedRx.tsx): cancelling an appointment
 * flips `status` to 'cancelled' rather than deleting the resource.
 * Appointment doesn't get the same full edit+version-history UI as
 * notes/prescriptions in this round — a plain status update is enough
 * for this slice (§16 scoping note in this task).
 *
 * Double-booking: handleBook() below checks the selected PRACTITIONER's
 * existing non-cancelled appointments for a time overlap before booking
 * (see appointmentsOverlap()). Scoped to practitioner-conflict only —
 * same-PATIENT double-booking (one patient booked into two overlapping
 * slots with different practitioners) is NOT checked. Known gap, not
 * hidden: see §16.
 */

const DURATIONS = [
  { value: '15', label: '15 min' },
  { value: '30', label: '30 min' },
  { value: '45', label: '45 min' },
  { value: '60', label: '60 min' },
];

const STATUS_COLOR: Record<string, string> = {
  booked: 'blue',
  pending: 'yellow',
  arrived: 'teal',
  fulfilled: 'green',
  cancelled: 'red',
  noshow: 'gray',
};

/**
 * actor.display is set at booking time (see handleBook below) so this
 * table can render patient/practitioner names without an extra fetch
 * per row — the same "store what you need to render" shortcut used
 * for DocumentReference.author.display elsewhere in this app. An
 * appointment booked some other way (e.g. direct API call without a
 * display) falls back to the bare reference string.
 */
function participantDisplay(appt: Appointment, type: 'Patient' | 'Practitioner'): string {
  const p = appt.participant?.find((pp) => pp.actor?.reference?.startsWith(`${type}/`));
  return p?.actor?.display ?? p?.actor?.reference ?? '—';
}

/**
 * Pure overlap check, no FHIR/React/browser dependency — unit-testable
 * on its own (see the standalone verification script referenced in this
 * change's commit message). Half-open interval semantics [start, end):
 * an appointment ending exactly when another starts is NOT an overlap
 * (back-to-back slots are allowed), matching how calendars normally work.
 * Accepts ISO date strings or Date objects for either range.
 */
export function appointmentsOverlap(
  existingStart: string | Date,
  existingEnd: string | Date,
  proposedStart: string | Date,
  proposedEnd: string | Date
): boolean {
  const es = new Date(existingStart).getTime();
  const ee = new Date(existingEnd).getTime();
  const ps = new Date(proposedStart).getTime();
  const pe = new Date(proposedEnd).getTime();
  return es < pe && ps < ee;
}

export function Scheduling() {
  const medplum = useMedplum();
  const [searchParams] = useSearchParams();
  const preselectedPatientId = searchParams.get('patientId') ?? undefined;

  const [appointments, setAppointments] = useState<Appointment[] | undefined>();

  const reloadAppointments = useCallback(() => {
    const today = new Date().toISOString().slice(0, 10);
    medplum.searchResources('Appointment', { date: `ge${today}`, _sort: 'date', _count: 50 }).then(setAppointments);
  }, [medplum]);

  useEffect(reloadAppointments, [reloadAppointments]);

  async function handleCancel(appt: Appointment) {
    if (!appt.id) return;
    try {
      const updated: Appointment = { ...appt, status: 'cancelled' };
      await medplum.updateResource(updated);
      notifications.show({ message: 'Appointment cancelled', color: 'green' });
      reloadAppointments();
    } catch (err) {
      notifications.show({ message: String(err), color: 'red' });
    }
  }

  return (
    <Stack maw={960}>
      <Title order={3}>Scheduling</Title>
      <Text size="sm" c="dimmed">
        Books a FHIR <code>Appointment</code> resource directly against Medplum — the next concrete
        slice of §16's "fully EHR/EMR" gap. Bed/ward management and full order workflows are still
        separate, unbuilt items.
      </Text>

      <BookAppointmentForm preselectedPatientId={preselectedPatientId} onBooked={reloadAppointments} />

      <Divider my="sm" />

      <Title order={4}>Upcoming appointments</Title>
      {appointments === undefined ? (
        <Loader size="sm" />
      ) : appointments.length === 0 ? (
        <Text c="dimmed">No upcoming appointments.</Text>
      ) : (
        <Table highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>When</Table.Th>
              <Table.Th>Patient</Table.Th>
              <Table.Th>Practitioner</Table.Th>
              <Table.Th>Reason / service</Table.Th>
              <Table.Th>Status</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {appointments.map((appt) => (
              <Table.Tr key={appt.id}>
                <Table.Td>{appt.start?.slice(0, 16).replace('T', ' ') ?? '—'}</Table.Td>
                <Table.Td>{participantDisplay(appt, 'Patient')}</Table.Td>
                <Table.Td>{participantDisplay(appt, 'Practitioner')}</Table.Td>
                <Table.Td>{appt.serviceType?.[0]?.text ?? '—'}</Table.Td>
                <Table.Td>
                  <Badge size="sm" color={STATUS_COLOR[appt.status ?? ''] ?? 'gray'} variant="light">
                    {appt.status}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  {appt.status !== 'cancelled' && appt.status !== 'fulfilled' && (
                    <Button size="xs" variant="subtle" color="red" onClick={() => handleCancel(appt)}>
                      Cancel
                    </Button>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}

function BookAppointmentForm({
  preselectedPatientId,
  onBooked,
}: {
  preselectedPatientId: string | undefined;
  onBooked: () => void;
}) {
  const medplum = useMedplum();
  const profile = useMedplumProfile();

  const [selectedPatient, setSelectedPatient] = useState<Patient | undefined>();
  const [patientQuery, setPatientQuery] = useState('');
  const [patientResults, setPatientResults] = useState<Patient[] | undefined>();

  const [practitioners, setPractitioners] = useState<Practitioner[] | undefined>();
  const [practitionerId, setPractitionerId] = useState<string | undefined>(
    profile?.resourceType === 'Practitioner' ? profile.id : undefined
  );

  const [when, setWhen] = useState('');
  const [duration, setDuration] = useState('30');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  // Deep-link pre-selection from PatientDetail.tsx's "Book appointment" quick action.
  useEffect(() => {
    if (preselectedPatientId) {
      medplum.readResource('Patient', preselectedPatientId).then(setSelectedPatient);
    }
  }, [medplum, preselectedPatientId]);

  // Default the practitioner to the signed-in clinician.
  useEffect(() => {
    if (profile?.resourceType === 'Practitioner' && !practitionerId) {
      setPractitionerId(profile.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    medplum.searchResources('Practitioner', { _count: 50, _sort: 'name' }).then(setPractitioners);
  }, [medplum]);

  // Live patient search-as-you-type, same pattern as PatientList.tsx.
  useEffect(() => {
    if (selectedPatient || !patientQuery.trim()) {
      setPatientResults(undefined);
      return;
    }
    let cancelled = false;
    medplum.searchResources('Patient', { name: patientQuery, _count: 10 }).then((result) => {
      if (!cancelled) setPatientResults(result);
    });
    return () => {
      cancelled = true;
    };
  }, [medplum, patientQuery, selectedPatient]);

  async function handleBook() {
    if (!selectedPatient?.id || !practitionerId || !when) return;
    setSaving(true);
    try {
      const start = new Date(when);
      const end = new Date(start.getTime() + Number(duration) * 60_000);
      const practitioner = practitioners?.find((p) => p.id === practitionerId);

      // Double-booking check (practitioner-conflict only, see header comment).
      // Fetch is widened a day on each side of the proposed slot — the FHIR
      // `date` param here is only a coarse server-side narrowing filter;
      // appointmentsOverlap() below is the real, precise [start,end) check,
      // so a timezone mismatch between browser and server in the day
      // boundary can't hide a real conflict, only (harmlessly) fetch a
      // few extra rows.
      const dayBefore = new Date(start.getFullYear(), start.getMonth(), start.getDate() - 1);
      const dayAfterEnd = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 2);
      const toDateParam = (d: Date) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const existingForPractitioner = await medplum.searchResources('Appointment', [
        ['actor', `Practitioner/${practitionerId}`],
        ['date', `ge${toDateParam(dayBefore)}`],
        ['date', `lt${toDateParam(dayAfterEnd)}`],
        ['status:not', 'cancelled'],
        ['_count', '100'],
      ]);
      const conflict = existingForPractitioner.find(
        (appt) => appt.start && appt.end && appointmentsOverlap(appt.start, appt.end, start, end)
      );
      if (conflict) {
        const conflictPatient = participantDisplay(conflict, 'Patient');
        const conflictWhen = conflict.start ? conflict.start.slice(0, 16).replace('T', ' ') : 'an existing slot';
        notifications.show({
          message:
            `${practitioner ? formatHumanName(practitioner.name) : 'This practitioner'} already has an appointment ` +
            `at ${conflictWhen}${conflictPatient !== '—' ? ` with ${conflictPatient}` : ''}. Pick a different time.`,
          color: 'red',
        });
        return;
      }

      await medplum.createResource({
        resourceType: 'Appointment',
        status: 'booked',
        start: start.toISOString(),
        end: end.toISOString(),
        serviceType: reason.trim() ? [{ text: reason.trim() }] : undefined,
        participant: [
          {
            actor: { reference: `Patient/${selectedPatient.id}`, display: formatHumanName(selectedPatient.name) },
            status: 'accepted',
          },
          {
            actor: {
              reference: `Practitioner/${practitionerId}`,
              display: practitioner ? formatHumanName(practitioner.name) : undefined,
            },
            status: 'accepted',
          },
        ],
      });
      notifications.show({ message: 'Appointment booked', color: 'green' });
      setSelectedPatient(undefined);
      setPatientQuery('');
      setWhen('');
      setReason('');
      onBooked();
    } catch (err) {
      notifications.show({ message: String(err), color: 'red' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Paper withBorder p="md">
      <Stack gap="sm">
        <Title order={5}>Book an appointment</Title>

        {selectedPatient ? (
          <Group justify="space-between">
            <Text>
              Patient:{' '}
              <Text span fw={600}>
                {formatHumanName(selectedPatient.name)}
              </Text>{' '}
              <Text span c="dimmed" size="sm">
                (MRN {formatPatientMrn(selectedPatient)})
              </Text>
            </Text>
            <Button size="xs" variant="subtle" onClick={() => setSelectedPatient(undefined)}>
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
              w={320}
            />
            {patientResults !== undefined && (
              <Paper withBorder p="xs" w={320}>
                {patientResults.length === 0 ? (
                  <Text size="sm" c="dimmed">
                    No matches.
                  </Text>
                ) : (
                  <Stack gap={2}>
                    {patientResults.map((p) => (
                      <Text
                        key={p.id}
                        size="sm"
                        style={{ cursor: 'pointer' }}
                        onClick={() => {
                          setSelectedPatient(p);
                          setPatientResults(undefined);
                        }}
                      >
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

        <Group align="flex-end">
          <Select
            label="Practitioner"
            placeholder="Select practitioner"
            data={(practitioners ?? []).filter((p) => p.id).map((p) => ({ value: p.id as string, label: formatHumanName(p.name) }))}
            value={practitionerId}
            onChange={(v) => setPractitionerId(v ?? undefined)}
            w={260}
            searchable
          />
          <TextInput
            label="Date & time"
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.currentTarget.value)}
            w={220}
          />
          <Select label="Duration" data={DURATIONS} value={duration} onChange={(v) => setDuration(v ?? '30')} w={120} />
        </Group>

        <DictationTextInput
          label="Reason / service type"
          placeholder="e.g. Follow-up, Cardiology consult"
          value={reason}
          onValueChange={setReason}
          patientId={selectedPatient?.id}
        />

        <Group justify="flex-end">
          <Button loading={saving} disabled={!selectedPatient || !practitionerId || !when} onClick={handleBook}>
            Book appointment
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}
