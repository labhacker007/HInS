import { useEffect, useState, useCallback } from 'react';
import { useParams, Link } from 'react-router';
import {
  Stack,
  Group,
  Title,
  Text,
  Badge,
  Paper,
  Textarea,
  Select,
  Button,
  Divider,
  Loader,
  Tabs,
  TextInput,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { DocumentReference, MedicationRequest, Patient } from '@medplum/fhirtypes';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import { formatHumanName, formatPatientMrn } from '../../lib/fhirFormat.js';
import { createConsent } from '../../lib/consentApi.js';

const ENCOUNTER_CLASS = {
  OPD: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'ambulatory' },
  IPD: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'IMP', display: 'inpatient encounter' },
} as const;

export function PatientDetail() {
  const { id } = useParams<{ id: string }>();
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const [patient, setPatient] = useState<Patient | undefined>();
  const [notes, setNotes] = useState<DocumentReference[] | undefined>();
  const [rx, setRx] = useState<MedicationRequest[] | undefined>();

  const reload = useCallback(() => {
    if (!id) return;
    medplum.readResource('Patient', id).then(setPatient);
    medplum.searchResources('DocumentReference', { subject: `Patient/${id}`, _sort: '-date', _count: 20 }).then(setNotes);
    medplum.searchResources('MedicationRequest', { subject: `Patient/${id}`, _sort: '-_lastUpdated', _count: 20 }).then(setRx);
  }, [medplum, id]);

  useEffect(reload, [reload]);

  if (!id) return null;
  if (!patient) return <Loader size="sm" />;

  return (
    <Stack>
      <Group justify="space-between">
        <div>
          <Title order={3}>{formatHumanName(patient.name)}</Title>
          <Text c="dimmed" size="sm">
            MRN {formatPatientMrn(patient)} · DOB {patient.birthDate ?? '—'} · {patient.gender ?? '—'}
          </Text>
        </div>
        <Button component={Link} to="/" variant="subtle">
          ← All patients
        </Button>
      </Group>

      <Tabs defaultValue="notes">
        <Tabs.List>
          <Tabs.Tab value="notes">Encounter notes</Tabs.Tab>
          <Tabs.Tab value="rx">Prescriptions</Tabs.Tab>
          <Tabs.Tab value="consent">Consent</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="notes" pt="md">
          <NewNoteForm
            patientId={id}
            practitionerId={profile?.id}
            onCreated={reload}
          />
          <Divider my="md" />
          <Stack gap="sm">
            {notes === undefined ? (
              <Loader size="sm" />
            ) : notes.length === 0 ? (
              <Text c="dimmed">No notes yet.</Text>
            ) : (
              notes.map((n) => <NoteCard key={n.id} note={n} />)
            )}
          </Stack>
        </Tabs.Panel>

        <Tabs.Panel value="rx" pt="md">
          <NewRxForm patientId={id} practitionerId={profile?.id} onCreated={reload} />
          <Divider my="md" />
          <Stack gap="sm">
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
        </Tabs.Panel>

        <Tabs.Panel value="consent" pt="md">
          <RequestConsentPanel patientId={id} requesterId={profile?.id} requesterName={formatHumanName(profile?.name)} />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}

function NoteCard({ note }: { note: DocumentReference }) {
  const data = note.content?.[0]?.attachment?.data;
  const text = data ? atob(data) : '(empty)';
  return (
    <Paper withBorder p="sm">
      <Group justify="space-between" mb={4}>
        <Badge size="sm" variant="light">
          {note.type?.text ?? 'Note'}
        </Badge>
        <Text size="xs" c="dimmed">
          {note.date?.slice(0, 16).replace('T', ' ')}
        </Text>
      </Group>
      <Text style={{ whiteSpace: 'pre-wrap' }}>{text}</Text>
    </Paper>
  );
}

function NewNoteForm({
  patientId,
  practitionerId,
  onCreated,
}: {
  patientId: string;
  practitionerId: string | undefined;
  onCreated: () => void;
}) {
  const medplum = useMedplum();
  const [setting, setSetting] = useState<'OPD' | 'IPD'>('OPD');
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    if (!text.trim()) return;
    setSaving(true);
    try {
      const encounter = await medplum.createResource({
        resourceType: 'Encounter',
        status: 'finished',
        class: ENCOUNTER_CLASS[setting],
        subject: { reference: `Patient/${patientId}` },
        participant: practitionerId
          ? [{ individual: { reference: `Practitioner/${practitionerId}` } }]
          : undefined,
        period: { start: new Date().toISOString() },
      });
      await medplum.createResource({
        resourceType: 'DocumentReference',
        status: 'current',
        type: { text: `${setting} note` },
        subject: { reference: `Patient/${patientId}` },
        context: { encounter: [{ reference: `Encounter/${encounter.id}` }] },
        date: new Date().toISOString(),
        content: [{ attachment: { contentType: 'text/plain', data: btoa(text) } }],
      });
      setText('');
      notifications.show({ message: 'Note saved', color: 'green' });
      onCreated();
    } catch (err) {
      notifications.show({ message: String(err), color: 'red' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Stack gap="xs">
      <Group>
        <Select
          label="Setting"
          data={[
            { value: 'OPD', label: 'OPD / clinic' },
            { value: 'IPD', label: 'Inpatient' },
          ]}
          value={setting}
          onChange={(v) => setSetting((v as 'OPD' | 'IPD') ?? 'OPD')}
          w={180}
        />
      </Group>
      <Textarea
        label="Note"
        placeholder="Chief complaint, exam findings, assessment, plan…"
        minRows={4}
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
      />
      <Group justify="flex-end">
        <Button size="sm" loading={saving} disabled={!text.trim()} onClick={handleSave}>
          Save note
        </Button>
      </Group>
    </Stack>
  );
}

function NewRxForm({
  patientId,
  practitionerId,
  onCreated,
}: {
  patientId: string;
  practitionerId: string | undefined;
  onCreated: () => void;
}) {
  const medplum = useMedplum();
  const [medication, setMedication] = useState('');
  const [dosage, setDosage] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    if (!medication.trim()) return;
    setSaving(true);
    try {
      await medplum.createResource({
        resourceType: 'MedicationRequest',
        status: 'active',
        intent: 'order',
        subject: { reference: `Patient/${patientId}` },
        requester: practitionerId ? { reference: `Practitioner/${practitionerId}` } : undefined,
        medicationCodeableConcept: { text: medication.trim() },
        dosageInstruction: dosage.trim() ? [{ text: dosage.trim() }] : undefined,
        authoredOn: new Date().toISOString(),
      });
      setMedication('');
      setDosage('');
      notifications.show({ message: 'Prescription created', color: 'green' });
      onCreated();
    } catch (err) {
      notifications.show({ message: String(err), color: 'red' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Stack gap="xs" maw={480}>
      <TextInput label="Medication" placeholder="e.g. Amoxicillin 500mg" value={medication} onChange={(e) => setMedication(e.currentTarget.value)} />
      <TextInput label="Dosage instructions" placeholder="e.g. 1 capsule 3x daily for 7 days" value={dosage} onChange={(e) => setDosage(e.currentTarget.value)} />
      <Group justify="flex-end">
        <Button size="sm" loading={saving} disabled={!medication.trim()} onClick={handleSave}>
          Create prescription
        </Button>
      </Group>
    </Stack>
  );
}

function RequestConsentPanel({
  patientId,
  requesterId,
  requesterName,
}: {
  patientId: string;
  requesterId: string | undefined;
  requesterName: string;
}) {
  const [sending, setSending] = useState(false);

  async function handleRequest() {
    if (!requesterId) return;
    setSending(true);
    try {
      const start = new Date();
      const expiry = new Date(start.getTime() + 30 * 24 * 60 * 60 * 1000);
      await createConsent({
        type: 'data_sharing',
        grantorPatientId: patientId,
        scope: ['OPDRecord', 'Prescription'],
        purposeCode: 'treatment',
        requesterId,
        requesterDisplayName: requesterName,
        validityStart: start.toISOString(),
        validityExpiry: expiry.toISOString(),
      });
      notifications.show({ message: 'Consent recorded for this patient', color: 'green' });
    } catch (err) {
      notifications.show({ message: String(err), color: 'red' });
    } finally {
      setSending(false);
    }
  }

  return (
    <Stack maw={480}>
      <Text size="sm" c="dimmed">
        Blueprint §04.2: in production, this would route through the patient's own
        consent-manager app for approval, not write the grant directly — that
        approval round trip isn't built yet (§16 open decisions). This button
        records a 30-day treatment-purpose consent grant directly, so the
        patient can see and revoke it from their own portal.
      </Text>
      <Button onClick={handleRequest} loading={sending} disabled={!requesterId}>
        Record 30-day data-sharing consent
      </Button>
    </Stack>
  );
}
