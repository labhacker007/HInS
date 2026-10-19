import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router';
import {
  Stack,
  Group,
  Title,
  Text,
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
import type { Condition, DocumentReference, MedicationRequest, Observation, Patient } from '@medplum/fhirtypes';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import { formatHumanName, formatPatientMrn } from '../../lib/fhirFormat.js';
import { createConsent, listConsentHistory, type ConsentApiRecord } from '../../lib/consentApi.js';
import { DiagnosesList, LabResultsList } from '../../components/ClinicalCoding.js';
import { VersionedNote } from '../../components/VersionedNote.js';
import { VersionedRx } from '../../components/VersionedRx.js';
import { DictateButton } from '../../components/DictateButton.js';
import { ConsentHistoryList } from '../../components/ConsentHistoryList.js';
import { PatientDemographics } from '../../components/PatientDemographics.js';
import { PatientLifestyle } from '../../components/PatientLifestyle.js';
import { PatientAllergies } from '../../components/PatientAllergies.js';
import { PatientVitals } from '../../components/PatientVitals.js';
import { ConsultNote } from '../../components/ConsultNote.js';
import { ReferralPanel } from '../../components/ReferralPanel.js';
import { DiagnosticOrders } from '../../components/DiagnosticOrders.js';
import { DiagnosticResults } from '../../components/DiagnosticResults.js';
import { DictationTextInput } from '../../components/DictationTextarea.js';

const ENCOUNTER_CLASS = {
  OPD: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'ambulatory' },
  IPD: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'IMP', display: 'inpatient encounter' },
} as const;

export function PatientDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const [patient, setPatient] = useState<Patient | undefined>();
  const [notes, setNotes] = useState<DocumentReference[] | undefined>();
  const [rx, setRx] = useState<MedicationRequest[] | undefined>();
  const [conditions, setConditions] = useState<Condition[] | undefined>();
  const [labs, setLabs] = useState<Observation[] | undefined>();

  const reload = useCallback(() => {
    if (!id) return;
    medplum.readResource('Patient', id).then(setPatient);
    medplum.searchResources('DocumentReference', { subject: `Patient/${id}`, _sort: '-date', _count: 20 }).then(setNotes);
    medplum.searchResources('MedicationRequest', { subject: `Patient/${id}`, _sort: '-_lastUpdated', _count: 20 }).then(setRx);
    medplum.searchResources('Condition', { subject: `Patient/${id}`, _sort: '-_lastUpdated', _count: 20 }).then(setConditions);
    medplum
      .searchResources('Observation', { subject: `Patient/${id}`, category: 'laboratory', _sort: '-date', _count: 20 })
      .then(setLabs);
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
        <Group gap="xs">
          {/* Deep-links to Scheduling.tsx / Billing.tsx with the patient pre-selected via ?patientId= */}
          <Button onClick={() => navigate(`/schedule?patientId=${id}`)}>Book appointment</Button>
          <Button variant="light" onClick={() => navigate(`/billing?patientId=${id}`)}>
            Billing
          </Button>
          <Button component={Link} to="/" variant="subtle">
            ← All patients
          </Button>
        </Group>
      </Group>

      <Tabs defaultValue="notes">
        <Tabs.List>
          <Tabs.Tab value="notes">Encounter notes</Tabs.Tab>
          <Tabs.Tab value="diagnoses">Diagnoses</Tabs.Tab>
          <Tabs.Tab value="labs">Labs</Tabs.Tab>
          <Tabs.Tab value="rx">Prescriptions</Tabs.Tab>
          <Tabs.Tab value="consent">Consent</Tabs.Tab>
          <Tabs.Tab value="demographics">Demographics</Tabs.Tab>
          <Tabs.Tab value="allergies">Allergies</Tabs.Tab>
          <Tabs.Tab value="vitals">Vitals</Tabs.Tab>
          <Tabs.Tab value="lifestyle">Social history &amp; diet</Tabs.Tab>
          <Tabs.Tab value="consult">Consult note</Tabs.Tab>
          <Tabs.Tab value="referrals">Referrals</Tabs.Tab>
          <Tabs.Tab value="dx-orders">Lab & imaging orders</Tabs.Tab>
          <Tabs.Tab value="dx-results">Diagnostic reports</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="notes" pt="md">
          <NewNoteForm
            patientId={id}
            practitionerId={profile?.id}
            practitionerName={formatHumanName(profile?.name)}
            onCreated={reload}
          />
          <Divider my="md" />
          <Stack gap="sm">
            {notes === undefined ? (
              <Loader size="sm" />
            ) : notes.length === 0 ? (
              <Text c="dimmed">No notes yet.</Text>
            ) : (
              notes.map((n) => <VersionedNote key={n.id} note={n} patientId={id} onSaved={reload} />)
            )}
          </Stack>
        </Tabs.Panel>

        <Tabs.Panel value="diagnoses" pt="md">
          <DiagnosesList conditions={conditions} />
        </Tabs.Panel>

        <Tabs.Panel value="labs" pt="md">
          <LabResultsList observations={labs} />
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
              rx.map((r) => <VersionedRx key={r.id} rx={r} patientId={id} onSaved={reload} />)
            )}
          </Stack>
        </Tabs.Panel>

        <Tabs.Panel value="consent" pt="md">
          <RequestConsentPanel patientId={id} requesterId={profile?.id} requesterName={formatHumanName(profile?.name)} />
        </Tabs.Panel>

        <Tabs.Panel value="demographics" pt="md">
          <PatientDemographics patient={patient} onSaved={reload} />
        </Tabs.Panel>
        <Tabs.Panel value="allergies" pt="md">
          <PatientAllergies patientId={id} />
        </Tabs.Panel>
        <Tabs.Panel value="vitals" pt="md">
          <PatientVitals patientId={id} />
        </Tabs.Panel>
        <Tabs.Panel value="lifestyle" pt="md">
          <PatientLifestyle patientId={id} />
        </Tabs.Panel>

        <Tabs.Panel value="consult" pt="md">
          <ConsultNote patientId={id} patientName={formatHumanName(patient.name)} onSaved={reload} />
        </Tabs.Panel>

        <Tabs.Panel value="referrals" pt="md">
          <ReferralPanel patientId={id} patientName={formatHumanName(patient.name)} />
        </Tabs.Panel>

        <Tabs.Panel value="dx-orders" pt="md">
          <DiagnosticOrders patientId={id} />
        </Tabs.Panel>

        <Tabs.Panel value="dx-results" pt="md">
          <DiagnosticResults patientId={id} />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}

function NewNoteForm({
  patientId,
  practitionerId,
  practitionerName,
  onCreated,
}: {
  patientId: string;
  practitionerId: string | undefined;
  practitionerName: string;
  onCreated: () => void;
}) {
  const medplum = useMedplum();
  const [setting, setSetting] = useState<'OPD' | 'IPD'>('OPD');
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);

  function appendDictated(chunk: string) {
    setText((prev) => (prev ? `${prev} ${chunk}` : chunk));
  }

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
        // DocumentReference.author, not meta.author — see
        // VersionedNote.tsx's header on why that distinction matters.
        author: practitionerId ? [{ reference: `Practitioner/${practitionerId}`, display: practitionerName }] : undefined,
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
      <Group justify="space-between">
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
        <DictateButton
          patientId={patientId}
          requesterId={practitionerId}
          requesterName={practitionerName}
          onTranscript={appendDictated}
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
      <DictationTextInput label="Dosage instructions" placeholder="e.g. 1 capsule 3x daily for 7 days" value={dosage} onValueChange={setDosage} patientId={patientId} />
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
  const [history, setHistory] = useState<ConsentApiRecord[] | undefined>();

  const reload = useCallback(() => {
    listConsentHistory(patientId).then(setHistory);
  }, [patientId]);

  useEffect(reload, [reload]);

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
        requiresApproval: true,
      });
      notifications.show({ message: 'Consent request sent — awaiting the patient’s approval', color: 'yellow' });
      reload();
    } catch (err) {
      notifications.show({ message: String(err), color: 'red' });
    } finally {
      setSending(false);
    }
  }

  return (
    <Stack maw={560}>
      <div>
        <Text size="sm" c="dimmed" mb="xs">
          Blueprint §04.2: this creates a 30-day treatment-purpose data-sharing
          <strong> request</strong>, not an immediate grant — it lands in the
          patient's own portal as "Pending approval" and only becomes active once
          they approve it there (§16's "Consent approval round trip" is now built,
          HIP/HIU side only — see services/consent-service/src/index.ts's header
          for what's still a real external Consent Manager app vs. this in-app
          round trip).
        </Text>
        <Button onClick={handleRequest} loading={sending} disabled={!requesterId}>
          Request 30-day data-sharing consent
        </Button>
      </div>

      <Divider my="xs" />

      {history === undefined ? (
        <Loader size="sm" />
      ) : (
        <ConsentHistoryList history={history} />
      )}
    </Stack>
  );
}
