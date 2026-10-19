import { useState } from 'react';
import { Alert, Button, Checkbox, FileInput, Group, List, SegmentedControl, Stack, Table, Text, Textarea, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { Patient, ServiceRequest } from '@medplum/fhirtypes';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import {
  DOCUMENT_TYPES,
  importDicom,
  importFhirResult,
  importHl7Oru,
  kindOf,
  oruMatchesPatient,
  prepareFhirImport,
  uploadResultDocument,
  type DicomFields,
  type PreparedFhirImport,
} from '../lib/diagnostics.js';
import { parseOru, type ParsedOru } from '../lib/hl7Oru.js';
import { parseDicomHeader, type DicomHeader } from '../lib/dicomHeader.js';

/**
 * Result upload for one order, in four industry formats:
 *   Document  PDF / JPEG / PNG -> Binary + DocumentReference + DiagnosticReport.presentedForm
 *   FHIR      DiagnosticReport or Bundle of Observations (JSON) -> server $validate, then create
 *   HL7 v2    ORU^R01 text -> Observations (OBX value/units/range/flag) — see lib/hl7Oru.ts
 *   DICOM     .dcm -> Binary (application/dicom) + ImagingStudy from the file header
 *             (lib/dicomHeader.ts); fields are editable, and entered manually when the
 *             header can't be read.
 * Structured formats get a preview (parsed rows + warnings) before anything
 * is written. Everything lands on the order's single working report as
 * 'preliminary' for pathologist/radiologist sign-off.
 *
 * Known gap, stated plainly: no virus/malware scanning of uploaded files,
 * and no size cap beyond Medplum's own request limit.
 */

type Format = 'document' | 'fhir' | 'hl7' | 'dicom';

export function ResultUpload({ order, patient, onDone }: { order: ServiceRequest; patient?: Patient; onDone: () => void }) {
  const isImaging = kindOf(order) === 'imaging';
  const [format, setFormat] = useState<Format>(isImaging ? 'dicom' : 'hl7');
  return (
    <Stack gap="sm">
      <SegmentedControl
        value={format}
        onChange={(v) => setFormat(v as Format)}
        data={[
          { value: 'document', label: 'PDF / image' },
          { value: 'hl7', label: 'HL7 v2 ORU' },
          { value: 'fhir', label: 'FHIR JSON' },
          { value: 'dicom', label: 'DICOM' },
        ]}
      />
      {format === 'document' && <DocumentForm order={order} onDone={onDone} />}
      {format === 'hl7' && <Hl7Form order={order} patient={patient} onDone={onDone} />}
      {format === 'fhir' && <FhirForm order={order} onDone={onDone} />}
      {format === 'dicom' && <DicomForm order={order} patient={patient} onDone={onDone} />}
    </Stack>
  );
}

function useRun(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  async function run(fn: () => Promise<{ warnings: string[] }>, ok: string) {
    setBusy(true);
    try {
      const r = await fn();
      notifications.show({ message: r.warnings.length ? `${ok} (${r.warnings.length} warning(s))` : ok, color: 'green' });
      onDone();
    } catch (err) {
      notifications.show({ message: (err as Error).message, color: 'red', autoClose: 15000 });
    } finally {
      setBusy(false);
    }
  }
  return { busy, run };
}

function Warnings({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <Alert color="yellow" p="xs" title="Check before importing">
      <List size="sm">
        {items.map((w) => (
          <List.Item key={w}>{w}</List.Item>
        ))}
      </List>
    </Alert>
  );
}

function DocumentForm({ order, onDone }: { order: ServiceRequest; onDone: () => void }) {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const { busy, run } = useRun(onDone);
  return (
    <Stack gap="xs">
      <FileInput label="Report file (PDF, JPEG or PNG)" accept={DOCUMENT_TYPES.join(',')} value={file} onChange={setFile} clearable />
      <TextInput label="Title (optional)" value={title} onChange={(e) => setTitle(e.currentTarget.value)} />
      <Group justify="flex-end">
        <Button
          size="sm"
          loading={busy}
          disabled={!file || !DOCUMENT_TYPES.includes(file.type)}
          onClick={() =>
            file &&
            run(
              () => uploadResultDocument(medplum, order.id as string, { data: file, filename: file.name, contentType: file.type, uploaderId: profile?.id, title }),
              'Document attached to report',
            )
          }
        >
          Upload
        </Button>
      </Group>
    </Stack>
  );
}

async function readText(file: File | null, pasted: string): Promise<string> {
  return file ? file.text() : pasted;
}

function Hl7Form({ order, patient, onDone }: { order: ServiceRequest; patient?: Patient; onDone: () => void }) {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const [file, setFile] = useState<File | null>(null);
  const [pasted, setPasted] = useState('');
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState<ParsedOru | undefined>();
  const [parseError, setParseError] = useState<string | undefined>();
  const [confirmed, setConfirmed] = useState(false);
  const { busy, run } = useRun(onDone);

  async function preview() {
    setParsed(undefined);
    setParseError(undefined);
    setConfirmed(false);
    try {
      const t = await readText(file, pasted);
      setText(t);
      setParsed(parseOru(t));
    } catch (err) {
      setParseError((err as Error).message);
    }
  }
  const matches = parsed ? oruMatchesPatient(parsed, patient) : false;

  return (
    <Stack gap="xs">
      <FileInput label="ORU^R01 message file (.hl7 / .txt)" accept=".hl7,.txt,text/plain" value={file} onChange={setFile} clearable />
      <Textarea label="…or paste the message" autosize minRows={3} maxRows={10} ff="monospace" value={pasted} onChange={(e) => setPasted(e.currentTarget.value)} disabled={!!file} />
      <Group justify="flex-end">
        <Button size="sm" variant="light" onClick={preview} disabled={!file && !pasted.trim()}>
          Preview
        </Button>
      </Group>
      {parseError && <Alert color="red">{parseError}</Alert>}
      {parsed && (
        <>
          <Text size="sm">
            {parsed.sendingFacility ?? 'Unknown sender'} · message {parsed.messageControlId ?? '—'} · PID {parsed.patientIdentifiers.join(', ') || '—'}{' '}
            {parsed.patientName ? `(${parsed.patientName})` : ''}
          </Text>
          <Table withTableBorder fz="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Test</Table.Th>
                <Table.Th>Value</Table.Th>
                <Table.Th>Range</Table.Th>
                <Table.Th>Flag</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {parsed.observations.map((o, i) => (
                <Table.Tr key={i}>
                  <Table.Td>{o.code.text}</Table.Td>
                  <Table.Td>{o.valueQuantity ? `${o.valueQuantity.comparator ?? ''}${o.valueQuantity.value} ${o.valueQuantity.unit ?? ''}` : (o.valueString ?? o.valueCodeableConcept?.text ?? '')}</Table.Td>
                  <Table.Td>{o.referenceRange?.[0]?.text}</Table.Td>
                  <Table.Td>{o.interpretation?.[0]?.text}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
          <Warnings items={parsed.warnings} />
          {!matches && (
            <Checkbox
              color="red"
              label="The message's patient identifier does not match this patient's identifiers. I have verified this result belongs to this patient."
              checked={confirmed}
              onChange={(e) => setConfirmed(e.currentTarget.checked)}
            />
          )}
          <Group justify="flex-end">
            <Button
              size="sm"
              loading={busy}
              disabled={!matches && !confirmed}
              onClick={() =>
                run(
                  () => importHl7Oru(medplum, order.id as string, text, { uploaderId: profile?.id, identityConfirmed: confirmed }),
                  `Imported ${parsed.observations.length} result(s)`,
                )
              }
            >
              Import {parsed.observations.length} result(s)
            </Button>
          </Group>
        </>
      )}
    </Stack>
  );
}

function FhirForm({ order, onDone }: { order: ServiceRequest; onDone: () => void }) {
  const medplum = useMedplum();
  const [file, setFile] = useState<File | null>(null);
  const [pasted, setPasted] = useState('');
  const [json, setJson] = useState<unknown>();
  const [prep, setPrep] = useState<PreparedFhirImport | undefined>();
  const [parseError, setParseError] = useState<string | undefined>();
  const { busy, run } = useRun(onDone);

  async function preview() {
    setPrep(undefined);
    setParseError(undefined);
    try {
      const parsed = JSON.parse(await readText(file, pasted));
      setJson(parsed);
      setPrep(prepareFhirImport(parsed, order));
    } catch (err) {
      setParseError((err as Error).message);
    }
  }
  return (
    <Stack gap="xs">
      <FileInput label="FHIR JSON (DiagnosticReport or Bundle with Observations)" accept=".json,application/json,application/fhir+json" value={file} onChange={setFile} clearable />
      <Textarea label="…or paste JSON" autosize minRows={3} maxRows={10} ff="monospace" value={pasted} onChange={(e) => setPasted(e.currentTarget.value)} disabled={!!file} />
      <Group justify="flex-end">
        <Button size="sm" variant="light" onClick={preview} disabled={!file && !pasted.trim()}>
          Preview
        </Button>
      </Group>
      {parseError && <Alert color="red">{parseError}</Alert>}
      {prep && (
        <>
          <Text size="sm">
            {prep.report ? '1 DiagnosticReport, ' : ''}
            {prep.observations.length} Observation(s): {prep.observations.map((o) => o.code?.text ?? o.code?.coding?.[0]?.display ?? o.code?.coding?.[0]?.code).join(', ')}
          </Text>
          <Warnings items={prep.warnings} />
          <Text size="xs" c="dimmed">
            Each resource is validated by the FHIR server ($validate) before anything is saved.
          </Text>
          <Group justify="flex-end">
            <Button size="sm" loading={busy} onClick={() => run(() => importFhirResult(medplum, order.id as string, json), 'FHIR results imported')}>
              Validate &amp; import
            </Button>
          </Group>
        </>
      )}
    </Stack>
  );
}

function DicomForm({ order, patient, onDone }: { order: ServiceRequest; patient?: Patient; onDone: () => void }) {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const [file, setFile] = useState<File | null>(null);
  const [buffer, setBuffer] = useState<ArrayBuffer | undefined>();
  const [header, setHeader] = useState<DicomHeader | undefined>();
  const [fields, setFields] = useState<DicomFields>({ studyInstanceUid: '', modality: '' });
  const { busy, run } = useRun(onDone);

  async function onFile(f: File | null) {
    setFile(f);
    setHeader(undefined);
    setBuffer(undefined);
    if (!f) return;
    const buf = await f.arrayBuffer();
    const h = parseDicomHeader(buf);
    setBuffer(buf);
    setHeader(h);
    setFields({
      studyInstanceUid: h.studyInstanceUid ?? '',
      seriesInstanceUid: h.seriesInstanceUid,
      sopInstanceUid: h.sopInstanceUid,
      sopClassUid: h.sopClassUid,
      modality: h.modality ?? '',
      studyDate: h.studyDate,
      description: h.studyDescription ?? h.seriesDescription,
      seriesNumber: h.seriesNumber,
      instanceNumber: h.instanceNumber,
      bodyPart: h.bodyPartExamined,
    });
  }
  const set = (k: keyof DicomFields) => (e: React.ChangeEvent<HTMLInputElement>) => setFields((p) => ({ ...p, [k]: e.currentTarget.value }));
  const pidMismatch =
    header?.patientId && !(patient?.identifier ?? []).some((i) => i.value === header.patientId)
      ? `File PatientID "${header.patientId}"${header.patientName ? ` (${header.patientName})` : ''} does not match any identifier on this patient — check you have the right study.`
      : undefined;

  return (
    <Stack gap="xs">
      <FileInput label="DICOM file (.dcm)" accept=".dcm,application/dicom" value={file} onChange={onFile} clearable />
      {header && !header.supported && <Alert color="yellow">{header.reason} Enter the study details manually.</Alert>}
      {header?.supported && <Text size="xs" c="dimmed">Read from file header (transfer syntax {header.transferSyntaxUid}). Edit if needed.</Text>}
      {file && (
        <>
          <Group grow>
            <TextInput label="StudyInstanceUID" required value={fields.studyInstanceUid} onChange={set('studyInstanceUid')} />
            <TextInput label="Modality (e.g. CR, CT, MR, US)" required value={fields.modality} onChange={set('modality')} w={120} />
          </Group>
          <Group grow>
            <TextInput label="Study date (YYYYMMDD)" value={fields.studyDate ?? ''} onChange={set('studyDate')} />
            <TextInput label="Description" value={fields.description ?? ''} onChange={set('description')} />
          </Group>
          {pidMismatch && <Alert color="yellow">{pidMismatch}</Alert>}
          <Group justify="flex-end">
            <Button
              size="sm"
              loading={busy}
              disabled={!buffer || !fields.studyInstanceUid.trim() || !fields.modality.trim()}
              onClick={() =>
                buffer &&
                file &&
                run(
                  () =>
                    importDicom(medplum, order.id as string, {
                      data: buffer,
                      filename: file.name,
                      uploaderId: profile?.id,
                      fields: { ...fields, studyInstanceUid: fields.studyInstanceUid.trim(), modality: fields.modality.trim().toUpperCase() },
                    }),
                  'DICOM study stored',
                )
              }
            >
              Store study
            </Button>
          </Group>
        </>
      )}
    </Stack>
  );
}
