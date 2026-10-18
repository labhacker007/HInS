import { useEffect, useState } from 'react';
import { Stack, Title, Text, Paper, Badge, Group, Loader } from '@mantine/core';
import type { Appointment } from '@medplum/fhirtypes';
import { useMedplum, useMedplumProfile } from '@medplum/react';

/**
 * Read-only — the patient-side slice of §16's scheduling gap. A patient
 * can see their own upcoming appointments but cannot book one from here;
 * booking is clinician-side only in this round (Scheduling.tsx). Letting
 * the patient book directly is a reasonable next slice, not built here —
 * stated plainly rather than silently left out.
 */
const STATUS_COLOR: Record<string, string> = {
  booked: 'blue',
  pending: 'yellow',
  arrived: 'teal',
  fulfilled: 'green',
  cancelled: 'red',
  noshow: 'gray',
};

export function MyAppointments() {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const [appointments, setAppointments] = useState<Appointment[] | undefined>();

  useEffect(() => {
    if (!profile?.id) return;
    const today = new Date().toISOString().slice(0, 10);
    medplum
      .searchResources('Appointment', { patient: `Patient/${profile.id}`, date: `ge${today}`, _sort: 'date', _count: 50 })
      .then(setAppointments);
  }, [medplum, profile?.id]);

  function practitionerName(appt: Appointment): string {
    const p = appt.participant?.find((pp) => pp.actor?.reference?.startsWith('Practitioner/'));
    return p?.actor?.display ?? p?.actor?.reference ?? 'Unknown practitioner';
  }

  return (
    <Stack maw={720}>
      <Title order={3}>Appointments</Title>

      {appointments === undefined ? (
        <Loader size="sm" />
      ) : appointments.length === 0 ? (
        <Text c="dimmed">No upcoming appointments.</Text>
      ) : (
        appointments.map((appt) => (
          <Paper key={appt.id} withBorder p="sm">
            <Group justify="space-between" mb={4}>
              <Text fw={600}>{appt.start?.slice(0, 16).replace('T', ' ') ?? 'No time set'}</Text>
              <Badge size="sm" color={STATUS_COLOR[appt.status ?? ''] ?? 'gray'} variant="light">
                {appt.status}
              </Badge>
            </Group>
            <Text size="sm">with {practitionerName(appt)}</Text>
            {appt.serviceType?.[0]?.text && (
              <Text size="sm" c="dimmed">
                {appt.serviceType[0].text}
              </Text>
            )}
          </Paper>
        ))
      )}
    </Stack>
  );
}
