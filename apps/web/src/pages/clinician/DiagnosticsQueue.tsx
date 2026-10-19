import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Alert, Anchor, Badge, Button, Group, Loader, Modal, SegmentedControl, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { Observation } from '@medplum/fhirtypes';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import { formatHumanName, formatPatientMrn } from '../../lib/fhirFormat.js';
import { deptName } from '../../lib/hospital.js';
import { collectSpecimen, getMyRoleCodes, loadQueue, markInProgress, PRIORITY_COLOR, type QueueItem } from '../../lib/diagnostics.js';
import { ResultUpload } from '../../components/ResultUpload.js';
import { ReportCard } from '../../components/DiagnosticResults.js';

/**
 * Department work queue — /lab and /radiology (same component, `dept` prop).
 * Shows every ACTIVE ServiceRequest whose performer is the department,
 * STAT first, then oldest first. Actions: collect specimen (lab), mark in
 * progress, upload result (ResultUpload.tsx), and review/sign the working
 * report (ReportCard, sign-off visible to pathologist/radiologist only).
 * Orders drop off the queue when the report is signed (order -> completed).
 *
 * Known gap, stated plainly: the queue is visible to any signed-in
 * Practitioner (department-scoped access is the RBAC track's job); no
 * auto-refresh/subscription — use Refresh; no barcode/label printing for
 * specimens; no worklist (DICOM MWL) feed to modalities.
 */
export function DiagnosticsQueue({ dept }: { dept: 'laboratory' | 'radiology' }) {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const navigate = useNavigate();
  const [items, setItems] = useState<QueueItem[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [roles, setRoles] = useState<Set<string>>(new Set());
  const [uploadFor, setUploadFor] = useState<QueueItem | undefined>();
  const [reviewFor, setReviewFor] = useState<QueueItem | undefined>();
  const [reviewObs, setReviewObs] = useState<Observation[]>([]);
  const [specimenFor, setSpecimenFor] = useState<QueueItem | undefined>();
  const [specimenType, setSpecimenType] = useState('');
  const [busyId, setBusyId] = useState<string | undefined>();

  const reload = useCallback(() => {
    setError(undefined);
    loadQueue(medplum, dept)
      .then(setItems)
      .catch((e) => setError(String(e)));
  }, [medplum, dept]);
  useEffect(() => {
    setItems(undefined);
    reload();
  }, [reload]);
  useEffect(() => {
    getMyRoleCodes(medplum, profile?.resourceType === 'Practitioner' ? profile.id : undefined).then(setRoles).catch(() => setRoles(new Set()));
  }, [medplum, profile]);

  async function act(item: QueueItem, fn: () => Promise<unknown>, msg: string) {
    setBusyId(item.order.id);
    try {
      await fn();
      notifications.show({ message: msg, color: 'green' });
      reload();
    } catch (err) {
      notifications.show({ message: (err as Error).message, color: 'red' });
      reload();
    } finally {
      setBusyId(undefined);
    }
  }

  async function openReview(item: QueueItem) {
    setReviewFor(item);
    setReviewObs([]);
    const refs = item.report?.result ?? [];
    const obs = await Promise.all(refs.map((r) => medplum.readReference(r, { cache: 'reload' }).catch(() => undefined)));
    setReviewObs(obs.filter((o) => !!o) as Observation[]);
  }

  return (
    <Stack>
      <Group justify="space-between">
        <Group>
          <Title order={3}>{deptName(dept)} work queue</Title>
          <SegmentedControl
            size="xs"
            value={dept}
            onChange={(v) => navigate(v === 'laboratory' ? '/lab' : '/radiology')}
            data={[
              { value: 'laboratory', label: 'Laboratory' },
              { value: 'radiology', label: 'Radiology' },
            ]}
          />
        </Group>
        <Button size="xs" variant="light" onClick={reload}>
          Refresh
        </Button>
      </Group>
      {error && <Alert color="red">{error}</Alert>}
      {items === undefined && !error ? (
        <Loader size="sm" />
      ) : items && items.length === 0 ? (
        <Text c="dimmed">No pending orders.</Text>
      ) : (
        <Table striped withTableBorder fz="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Priority</Table.Th>
              <Table.Th>Test / study</Table.Th>
              <Table.Th>Patient</Table.Th>
              <Table.Th>Ordered</Table.Th>
              <Table.Th>Status</Table.Th>
              <Table.Th>Actions</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {items?.map((it) => {
              const o = it.order;
              const busy = busyId === o.id;
              const signed = it.report && !['registered', 'partial', 'preliminary'].includes(it.report.status);
              return (
                <Table.Tr key={o.id}>
                  <Table.Td>
                    <Badge color={PRIORITY_COLOR[o.priority ?? 'routine']}>{o.priority ?? 'routine'}</Badge>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" fw={500}>
                      {o.code?.text ?? o.code?.coding?.[0]?.display}
                    </Text>
                    {o.note?.map((n, i) => (
                      <Text key={i} size="xs" c="dimmed">
                        {n.text}
                      </Text>
                    ))}
                  </Table.Td>
                  <Table.Td>
                    {it.patient ? (
                      <Anchor component={Link} to={`/patients/${it.patient.id}`} size="sm">
                        {formatHumanName(it.patient.name)}
                      </Anchor>
                    ) : (
                      o.subject?.reference
                    )}
                    {it.patient && (
                      <Text size="xs" c="dimmed">
                        MRN {formatPatientMrn(it.patient)}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs">{o.authoredOn?.slice(0, 16).replace('T', ' ')}</Text>
                    <Text size="xs" c="dimmed">
                      {o.requester?.display ?? ''}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs">{it.task?.businessStatus?.text ?? (it.task ? 'In progress' : 'New')}</Text>
                    {it.specimens.map((s) => (
                      <Text key={s.id} size="xs" c="dimmed">
                        Specimen: {s.type?.text ?? 'collected'} {s.collection?.collectedDateTime?.slice(11, 16)}
                      </Text>
                    ))}
                    {it.report && (
                      <Text size="xs">
                        Report: <strong>{it.report.status}</strong>
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Group gap={4}>
                      {dept === 'laboratory' && !it.report && (
                        <Button size="compact-xs" variant="light" onClick={() => setSpecimenFor(it)}>
                          Collect specimen
                        </Button>
                      )}
                      {!it.task && (
                        <Button
                          size="compact-xs"
                          variant="light"
                          loading={busy}
                          onClick={() => act(it, () => markInProgress(medplum, o.id as string, { performerId: profile?.id }), 'Marked in progress')}
                        >
                          Start
                        </Button>
                      )}
                      {!signed && (
                        <Button size="compact-xs" onClick={() => setUploadFor(it)}>
                          Upload result
                        </Button>
                      )}
                      {it.report && (
                        <Button size="compact-xs" variant="outline" onClick={() => openReview(it)}>
                          Review / sign
                        </Button>
                      )}
                    </Group>
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      )}

      <Modal opened={!!uploadFor} onClose={() => setUploadFor(undefined)} title={`Upload result — ${uploadFor?.order.code?.text ?? ''}`} size="lg">
        {uploadFor && (
          <ResultUpload
            order={uploadFor.order}
            patient={uploadFor.patient}
            onDone={() => {
              setUploadFor(undefined);
              reload();
            }}
          />
        )}
      </Modal>

      <Modal opened={!!reviewFor} onClose={() => setReviewFor(undefined)} title="Review report" size="xl">
        {reviewFor?.report && (
          <ReportCard
            report={reviewFor.report}
            observations={reviewObs}
            roles={roles}
            onChanged={() => {
              setReviewFor(undefined);
              reload();
            }}
          />
        )}
      </Modal>

      <Modal opened={!!specimenFor} onClose={() => setSpecimenFor(undefined)} title="Collect specimen">
        <Stack gap="xs">
          <TextInput
            label="Specimen type"
            placeholder="e.g. Venous blood (EDTA), Serum, Urine midstream"
            description="Free text — no specimen-type terminology is loaded"
            value={specimenType}
            onChange={(e) => setSpecimenType(e.currentTarget.value)}
          />
          <Group justify="flex-end">
            <Button
              size="sm"
              disabled={!specimenType.trim()}
              loading={!!specimenFor && busyId === specimenFor.order.id}
              onClick={() => {
                const it = specimenFor;
                if (!it) return;
                act(it, () => collectSpecimen(medplum, it.order.id as string, { typeText: specimenType, collectorId: profile?.id }), 'Specimen recorded').then(() => {
                  setSpecimenFor(undefined);
                  setSpecimenType('');
                });
              }}
            >
              Record collection
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
