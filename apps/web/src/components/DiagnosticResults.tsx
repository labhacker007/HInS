import { useCallback, useEffect, useState } from 'react';
import { Alert, Anchor, Badge, Button, Group, Loader, Paper, Stack, Table, Text, Textarea, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { Attachment, DiagnosticReport, DocumentReference, ImagingStudy, Observation, Reference } from '@medplum/fhirtypes';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import { formatHumanName } from '../lib/fhirFormat.js';
import { roleName } from '../lib/hospital.js';
import { ABNORMAL_FLAGS } from '../lib/hl7Oru.js';
import {
  amendReport,
  canSignOff,
  dicomFilesForStudy,
  getMyRoleCodes,
  loadPatientReports,
  reportKind,
  signOffReport,
  SIGNER_ROLE,
  type PatientReport,
} from '../lib/diagnostics.js';

/**
 * Patient-chart results view + the report card reused by the /lab and
 * /radiology work queues (DiagnosticsQueue.tsx). Workflow logic lives in
 * lib/diagnostics.ts; this file only renders and calls it.
 *
 * Attachments: Medplum rewrites `Binary/...` attachment URLs to short-lived
 * presigned /storage URLs when the report is read (verified live), so PDFs
 * and images render inline with no extra auth plumbing. Those URLs expire —
 * reloading the report refreshes them.
 *
 * Known gap, stated plainly: DICOM images are NOT viewable in the browser
 * yet. The study's metadata is shown and the original .dcm can be
 * downloaded; OHIF Viewer (MIT) backed by a DICOMweb endpoint is the
 * planned viewer, and neither OHIF nor a DICOMweb server (e.g. Orthanc's
 * DICOMweb plugin) is deployed in this stack today.
 *
 * Sign-off/amend buttons render only for the matching PractitionerRole
 * (pathologist for lab, radiologist for imaging) — UI gating only; see the
 * "Known gaps" in lib/diagnostics.ts on server-side enforcement.
 */

const STATUS_COLOR: Record<string, string> = {
  registered: 'gray',
  partial: 'yellow',
  preliminary: 'yellow',
  final: 'green',
  amended: 'blue',
  corrected: 'blue',
  cancelled: 'gray',
  'entered-in-error': 'red',
};

export function isAbnormal(o: Observation): boolean {
  return !!o.interpretation?.some((i) => i.coding?.some((c) => c.code && ABNORMAL_FLAGS.has(c.code)));
}

function formatValue(o: Observation): string {
  if (o.valueQuantity) {
    const q = o.valueQuantity;
    return `${q.comparator ?? ''}${q.value ?? ''} ${q.unit ?? q.code ?? ''}`.trim();
  }
  if (o.valueString !== undefined) return o.valueString;
  if (o.valueCodeableConcept) return o.valueCodeableConcept.text ?? o.valueCodeableConcept.coding?.[0]?.display ?? '';
  if (o.status === 'cancelled') return '(not obtained)';
  return '—';
}

function formatRange(o: Observation): string {
  const r = o.referenceRange?.[0];
  if (!r) return '';
  if (r.text) return r.text;
  return [r.low?.value, r.high?.value].map((v) => (v === undefined ? '' : String(v))).join(' – ');
}

export function ObservationTable({ observations }: { observations: Observation[] }) {
  if (!observations.length) return null;
  return (
    <Table striped withTableBorder fz="sm">
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Test</Table.Th>
          <Table.Th>Result</Table.Th>
          <Table.Th>Reference range</Table.Th>
          <Table.Th>Flag</Table.Th>
          <Table.Th>Status</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {observations.map((o) => {
          const abnormal = isAbnormal(o);
          const loinc = o.code.coding?.find((c) => c.system === 'http://loinc.org');
          return (
            <Table.Tr key={o.id} bg={abnormal ? 'var(--mantine-color-red-light)' : undefined}>
              <Table.Td>
                <Text size="sm" fw={500}>
                  {o.code.text ?? loinc?.display ?? 'Result'}
                </Text>
                {loinc && (
                  <Text size="xs" c="dimmed">
                    LOINC {loinc.code}
                  </Text>
                )}
              </Table.Td>
              <Table.Td fw={abnormal ? 700 : undefined} c={abnormal ? 'red' : undefined}>
                {formatValue(o)}
              </Table.Td>
              <Table.Td>{formatRange(o)}</Table.Td>
              <Table.Td>
                {o.interpretation?.[0] && (
                  <Badge color={abnormal ? 'red' : 'gray'} variant={abnormal ? 'filled' : 'light'} size="sm">
                    {o.interpretation[0].coding?.[0]?.code ?? ''} {o.interpretation[0].text ?? ''}
                  </Badge>
                )}
              </Table.Td>
              <Table.Td>
                <Text size="xs">{o.status}</Text>
              </Table.Td>
            </Table.Tr>
          );
        })}
      </Table.Tbody>
    </Table>
  );
}

function AttachmentView({ a }: { a: Attachment }) {
  if (!a.url) return <Text size="sm">{a.title ?? 'Attachment'} (no URL)</Text>;
  return (
    <Stack gap={4}>
      <Anchor href={a.url} target="_blank" rel="noreferrer" size="sm">
        {a.title ?? 'Attachment'} ({a.contentType})
      </Anchor>
      {a.contentType?.startsWith('image/') && (
        <img src={a.url} alt={a.title ?? 'result image'} style={{ maxWidth: '100%', maxHeight: 480, objectFit: 'contain' }} />
      )}
      {a.contentType === 'application/pdf' && (
        <iframe src={a.url} title={a.title ?? 'PDF report'} style={{ width: '100%', height: 480, border: '1px solid var(--mantine-color-default-border)' }} />
      )}
    </Stack>
  );
}

function ImagingStudyView({ studyRef }: { studyRef: Reference<ImagingStudy> }) {
  const medplum = useMedplum();
  const [study, setStudy] = useState<ImagingStudy | undefined>();
  const [files, setFiles] = useState<DocumentReference[]>([]);
  const key = studyRef.reference;
  useEffect(() => {
    if (!key) return;
    medplum
      .readReference<ImagingStudy>({ reference: key })
      .then((s) => {
        setStudy(s);
        dicomFilesForStudy(medplum, s.id as string).then(setFiles).catch(() => setFiles([]));
      })
      .catch(() => setStudy(undefined));
  }, [medplum, key]);
  if (!study) return <Loader size="xs" />;
  return (
    <Paper withBorder p="xs">
      <Text size="sm" fw={500}>
        Imaging study · {study.modality?.map((m) => m.code).join(', ')} · {study.started ?? 'date unknown'}
        {study.description ? ` · ${study.description}` : ''}
      </Text>
      <Text size="xs" c="dimmed" style={{ wordBreak: 'break-all' }}>
        StudyInstanceUID {study.identifier?.[0]?.value?.replace('urn:oid:', '')} · {study.numberOfSeries ?? 0} series ·{' '}
        {study.numberOfInstances ?? 0} instance(s)
      </Text>
      <Group gap="xs" mt={4}>
        {files.map((f) =>
          f.content[0]?.attachment.url ? (
            <Anchor key={f.id} href={f.content[0].attachment.url} size="sm">
              Download .dcm
            </Anchor>
          ) : null,
        )}
      </Group>
      <Text size="xs" c="dimmed" mt={4}>
        In-browser DICOM viewing is not available yet — planned: OHIF Viewer (MIT) on a DICOMweb endpoint. Open the
        downloaded file in a desktop DICOM viewer meanwhile.
      </Text>
    </Paper>
  );
}

export function ReportCard({
  report,
  observations,
  roles,
  onChanged,
}: {
  report: DiagnosticReport;
  observations: Observation[];
  roles: Set<string>;
  onChanged: () => void;
}) {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const kind = reportKind(report);
  const open = ['registered', 'partial', 'preliminary'].includes(report.status);
  const signed = ['final', 'amended', 'corrected'].includes(report.status);
  const mayAct = profile?.resourceType === 'Practitioner' && canSignOff(roles, kind);
  const [conclusion, setConclusion] = useState(report.conclusion?.replace(/\n\n\[Amended[\s\S]*$/, '') ?? '');
  const [reason, setReason] = useState('');
  const [amending, setAmending] = useState(false);
  const [busy, setBusy] = useState(false);

  async function act(kindOfAct: 'sign' | 'amend') {
    if (!profile?.id) return;
    setBusy(true);
    try {
      const who = { interpreterId: profile.id, interpreterName: formatHumanName(profile.name) };
      if (kindOfAct === 'sign') await signOffReport(medplum, report.id as string, { conclusion, ...who });
      else await amendReport(medplum, report.id as string, { conclusion, reason, ...who });
      notifications.show({ message: kindOfAct === 'sign' ? 'Report signed (final)' : 'Report amended', color: 'green' });
      setAmending(false);
      setReason('');
      onChanged();
    } catch (err) {
      notifications.show({ message: (err as Error).message, color: 'red', autoClose: 10000 });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Paper withBorder p="sm">
      <Stack gap="xs">
        <Group justify="space-between" align="flex-start">
          <div>
            <Text fw={600}>{report.code.text ?? report.code.coding?.[0]?.display ?? 'Diagnostic report'}</Text>
            <Text size="xs" c="dimmed">
              {kind === 'imaging' ? 'Radiology' : 'Laboratory'} · {report.effectiveDateTime?.slice(0, 16).replace('T', ' ') ?? '—'}
              {report.issued ? ` · issued ${report.issued.slice(0, 16).replace('T', ' ')}` : ''}
              {report.resultsInterpreter?.length ? ` · signed by ${report.resultsInterpreter.map((r) => r.display ?? r.reference).join(', ')}` : ''}
            </Text>
          </div>
          <Badge color={STATUS_COLOR[report.status] ?? 'gray'}>{report.status}</Badge>
        </Group>

        <ObservationTable observations={observations} />
        {report.presentedForm?.map((a, i) => <AttachmentView key={`${a.url}-${i}`} a={a} />)}
        {report.imagingStudy?.map((s) => <ImagingStudyView key={s.reference} studyRef={s} />)}

        {report.conclusion && !(open && mayAct) && !amending && (
          <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
            <strong>Conclusion:</strong> {report.conclusion}
          </Text>
        )}

        {open && !mayAct && (
          <Text size="xs" c="dimmed">
            Awaiting sign-off by a {roleName(SIGNER_ROLE[kind])}.
          </Text>
        )}
        {open && mayAct && (
          <Stack gap="xs">
            <Textarea label="Conclusion / impression" minRows={3} value={conclusion} onChange={(e) => setConclusion(e.currentTarget.value)} />
            <Group justify="flex-end">
              <Button size="xs" loading={busy} disabled={!conclusion.trim()} onClick={() => act('sign')}>
                Sign off as final
              </Button>
            </Group>
          </Stack>
        )}
        {signed && mayAct && !amending && (
          <Group justify="flex-end">
            <Button size="xs" variant="light" onClick={() => setAmending(true)}>
              Amend report
            </Button>
          </Group>
        )}
        {signed && mayAct && amending && (
          <Stack gap="xs">
            <Alert color="blue" p="xs">
              Amending keeps the signed version in the record history; the report becomes "amended".
            </Alert>
            <Textarea label="Corrected conclusion" minRows={3} value={conclusion} onChange={(e) => setConclusion(e.currentTarget.value)} />
            <TextInput label="Reason for amendment" value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
            <Group justify="flex-end">
              <Button size="xs" variant="subtle" onClick={() => setAmending(false)}>
                Cancel
              </Button>
              <Button size="xs" loading={busy} disabled={!conclusion.trim() || !reason.trim()} onClick={() => act('amend')}>
                Save amendment
              </Button>
            </Group>
          </Stack>
        )}
      </Stack>
    </Paper>
  );
}

/** Chart tab: every DiagnosticReport for the patient, newest first. */
export function DiagnosticResults({ patientId }: { patientId: string }) {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const [reports, setReports] = useState<PatientReport[] | undefined>();
  const [roles, setRoles] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | undefined>();

  const reload = useCallback(() => {
    loadPatientReports(medplum, patientId)
      .then(setReports)
      .catch((e) => setError(String(e)));
  }, [medplum, patientId]);
  useEffect(reload, [reload]);
  useEffect(() => {
    getMyRoleCodes(medplum, profile?.resourceType === 'Practitioner' ? profile.id : undefined).then(setRoles).catch(() => setRoles(new Set()));
  }, [medplum, profile]);

  if (error) return <Alert color="red">{error}</Alert>;
  if (!reports) return <Loader size="sm" />;
  if (!reports.length) return <Text c="dimmed">No diagnostic reports yet.</Text>;
  return (
    <Stack gap="sm">
      {reports.map((r) => (
        <ReportCard key={r.report.id} report={r.report} observations={r.observations} roles={roles} onChanged={reload} />
      ))}
    </Stack>
  );
}
