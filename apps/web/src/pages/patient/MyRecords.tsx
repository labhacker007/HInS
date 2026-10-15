import { useEffect, useState } from 'react';
import { Stack, Title, Text, Paper, Badge, Group, Loader, Divider } from '@mantine/core';
import type { Condition, DocumentReference, MedicationRequest, Observation } from '@medplum/fhirtypes';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import { DiagnosesList, LabResultsList } from '../../components/ClinicalCoding.js';

/** Read-only — a patient views their own chart, never edits it directly. */
export function MyRecords() {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const [notes, setNotes] = useState<DocumentReference[] | undefined>();
  const [rx, setRx] = useState<MedicationRequest[] | undefined>();
  const [conditions, setConditions] = useState<Condition[] | undefined>();
  const [labs, setLabs] = useState<Observation[] | undefined>();

  useEffect(() => {
    if (!profile?.id) return;
    medplum.searchResources('DocumentReference', { subject: `Patient/${profile.id}`, _sort: '-date', _count: 20 }).then(setNotes);
    medplum.searchResources('MedicationRequest', { subject: `Patient/${profile.id}`, _sort: '-_lastUpdated', _count: 20 }).then(setRx);
    medplum.searchResources('Condition', { subject: `Patient/${profile.id}`, _sort: '-_lastUpdated', _count: 20 }).then(setConditions);
    medplum
      .searchResources('Observation', { subject: `Patient/${profile.id}`, category: 'laboratory', _sort: '-date', _count: 20 })
      .then(setLabs);
  }, [medplum, profile?.id]);

  return (
    <Stack maw={720}>
      <Title order={3}>My Records</Title>

      <Title order={5} mt="md">
        Visit notes
      </Title>
      {notes === undefined ? (
        <Loader size="sm" />
      ) : notes.length === 0 ? (
        <Text c="dimmed">No visit notes yet.</Text>
      ) : (
        notes.map((n) => {
          const data = n.content?.[0]?.attachment?.data;
          return (
            <Paper key={n.id} withBorder p="sm">
              <Group justify="space-between" mb={4}>
                <Badge size="sm" variant="light">
                  {n.type?.text ?? 'Note'}
                </Badge>
                <Text size="xs" c="dimmed">
                  {n.date?.slice(0, 16).replace('T', ' ')}
                </Text>
              </Group>
              <Text style={{ whiteSpace: 'pre-wrap' }}>{data ? atob(data) : '(empty)'}</Text>
            </Paper>
          );
        })
      )}

      <Divider my="sm" />

      <Title order={5}>Diagnoses</Title>
      <DiagnosesList conditions={conditions} />

      <Divider my="sm" />

      <Title order={5}>Lab results</Title>
      <LabResultsList observations={labs} />

      <Divider my="sm" />

      <Title order={5}>Prescriptions</Title>
      {rx === undefined ? (
        <Loader size="sm" />
      ) : rx.length === 0 ? (
        <Text c="dimmed">No prescriptions yet.</Text>
      ) : (
        rx.map((r) => (
          <Paper key={r.id} withBorder p="sm">
            <Text fw={600}>{r.medicationCodeableConcept?.text}</Text>
            <Text size="sm" c="dimmed">
              {r.dosageInstruction?.[0]?.text} · {r.authoredOn?.slice(0, 10)}
            </Text>
          </Paper>
        ))
      )}
    </Stack>
  );
}
