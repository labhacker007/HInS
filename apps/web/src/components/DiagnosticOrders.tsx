import { useCallback, useEffect, useState } from 'react';
import { Alert, Autocomplete, Badge, Button, Divider, Group, Loader, Paper, SegmentedControl, Select, Stack, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { DiagnosticReport, Encounter, ServiceRequest, Task } from '@medplum/fhirtypes';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import { formatHumanName } from '../lib/fhirFormat.js';
import {
  cancelOrder,
  createOrder,
  IMAGING_SUGGESTIONS,
  kindOf,
  LAB_TESTS,
  PRIORITY_COLOR,
  type DiagKind,
  type OrderPriority,
} from '../lib/diagnostics.js';

/**
 * Chart tab: order lab tests / imaging studies and track them.
 * Lab tests come from the verified-LOINC catalogue in lib/diagnostics.ts;
 * imaging is free text (suggestions only, no invented procedure codes).
 * The order is routed to the Laboratory or Radiology department
 * Organization and shows up in that department's work queue (/lab, /radiology).
 *
 * Known gap, stated plainly: no duplicate-order check, no clinical decision
 * support (appropriateness criteria for imaging), no specimen-requirement
 * hints per test, and ordering is open to any signed-in Practitioner.
 */

const PRIORITIES: { value: OrderPriority; label: string }[] = [
  { value: 'routine', label: 'Routine' },
  { value: 'urgent', label: 'Urgent' },
  { value: 'stat', label: 'STAT' },
];

export function DiagnosticOrders({ patientId }: { patientId: string }) {
  const medplum = useMedplum();
  const [orders, setOrders] = useState<ServiceRequest[] | undefined>();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [reports, setReports] = useState<DiagnosticReport[]>([]);

  const reload = useCallback(() => {
    const opts = { cache: 'reload' as const };
    medplum.searchResources('ServiceRequest', { subject: `Patient/${patientId}`, _sort: '-authored', _count: '50' }, opts).then(setOrders);
    medplum.searchResources('Task', { patient: `Patient/${patientId}`, _count: '100' }, opts).then(setTasks);
    medplum.searchResources('DiagnosticReport', { subject: `Patient/${patientId}`, _count: '100' }, opts).then(setReports);
  }, [medplum, patientId]);
  useEffect(reload, [reload]);

  return (
    <Stack>
      <NewOrderForm patientId={patientId} onCreated={reload} />
      <Divider />
      {orders === undefined ? (
        <Loader size="sm" />
      ) : orders.length === 0 ? (
        <Text c="dimmed">No lab or imaging orders yet.</Text>
      ) : (
        orders.map((o) => (
          <OrderRow
            key={o.id}
            order={o}
            task={tasks.find((t) => t.focus?.reference === `ServiceRequest/${o.id}` && t.status !== 'cancelled')}
            report={reports.find((r) => r.basedOn?.some((b) => b.reference === `ServiceRequest/${o.id}`))}
            onChanged={reload}
          />
        ))
      )}
    </Stack>
  );
}

function NewOrderForm({ patientId, onCreated }: { patientId: string; onCreated: () => void }) {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const [kind, setKind] = useState<DiagKind>('laboratory');
  const [loinc, setLoinc] = useState<string | null>(null);
  const [imaging, setImaging] = useState('');
  const [priority, setPriority] = useState<OrderPriority>('routine');
  const [encounterId, setEncounterId] = useState<string | null>(null);
  const [encounters, setEncounters] = useState<Encounter[]>([]);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    medplum.searchResources('Encounter', { subject: `Patient/${patientId}`, _sort: '-date', _count: '10' }).then(setEncounters).catch(() => setEncounters([]));
  }, [medplum, patientId]);

  const text = kind === 'laboratory' ? (LAB_TESTS.find((t) => t.code === loinc)?.label ?? '') : imaging.trim();

  async function save() {
    setSaving(true);
    try {
      await createOrder(medplum, {
        patientId,
        kind,
        loinc: kind === 'laboratory' ? (loinc ?? undefined) : undefined,
        text,
        priority,
        requesterId: profile?.resourceType === 'Practitioner' ? profile.id : undefined,
        requesterName: formatHumanName(profile?.name),
        encounterId: encounterId ?? undefined,
        note,
      });
      notifications.show({ message: `Order sent to ${kind === 'laboratory' ? 'Laboratory' : 'Radiology'}`, color: 'green' });
      setLoinc(null);
      setImaging('');
      setNote('');
      setPriority('routine');
      onCreated();
    } catch (err) {
      notifications.show({ message: (err as Error).message, color: 'red' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Stack gap="xs" maw={640}>
      <SegmentedControl
        value={kind}
        onChange={(v) => setKind(v as DiagKind)}
        data={[
          { value: 'laboratory', label: 'Lab test' },
          { value: 'imaging', label: 'Imaging' },
        ]}
        w={260}
      />
      {kind === 'laboratory' ? (
        <Select
          label="Test"
          searchable
          placeholder="Choose a test"
          data={LAB_TESTS.map((t) => ({ value: t.code, label: `${t.label} (LOINC ${t.code})` }))}
          value={loinc}
          onChange={setLoinc}
        />
      ) : (
        <Autocomplete
          label="Study"
          placeholder="e.g. X-ray chest PA view"
          description="Free text — no coded imaging procedure terminology is loaded"
          data={IMAGING_SUGGESTIONS}
          value={imaging}
          onChange={setImaging}
        />
      )}
      <Group grow>
        <Select label="Priority" data={PRIORITIES} value={priority} onChange={(v) => setPriority((v as OrderPriority) ?? 'routine')} allowDeselect={false} />
        <Select
          label="Encounter (optional)"
          clearable
          placeholder="None"
          data={encounters.map((e) => ({
            value: e.id as string,
            label: `${e.class?.display ?? e.class?.code ?? 'Encounter'} · ${e.period?.start?.slice(0, 10) ?? '—'} · ${e.status}`,
          }))}
          value={encounterId}
          onChange={setEncounterId}
        />
      </Group>
      <TextInput label="Clinical note for the department (optional)" value={note} onChange={(e) => setNote(e.currentTarget.value)} />
      <Group justify="flex-end">
        <Button size="sm" loading={saving} disabled={!text} onClick={save}>
          Place order
        </Button>
      </Group>
    </Stack>
  );
}

function OrderRow({ order, task, report, onChanged }: { order: ServiceRequest; task?: Task; report?: DiagnosticReport; onChanged: () => void }) {
  const medplum = useMedplum();
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const statusText =
    order.status === 'active' ? (task?.businessStatus?.text ?? (task ? 'In progress' : 'Ordered — awaiting department')) : order.status;

  async function doCancel() {
    setBusy(true);
    try {
      await cancelOrder(medplum, order.id as string, reason);
      notifications.show({ message: 'Order cancelled', color: 'green' });
      onChanged();
    } catch (err) {
      notifications.show({ message: (err as Error).message, color: 'red' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Paper withBorder p="sm">
      <Group justify="space-between" align="flex-start">
        <div>
          <Group gap="xs">
            <Text fw={600}>{order.code?.text ?? order.code?.coding?.[0]?.display}</Text>
            <Badge size="sm" color={PRIORITY_COLOR[order.priority ?? 'routine']}>
              {order.priority ?? 'routine'}
            </Badge>
            <Badge size="sm" variant="outline">
              {kindOf(order) === 'imaging' ? 'Imaging' : 'Lab'}
            </Badge>
          </Group>
          <Text size="xs" c="dimmed">
            Ordered {order.authoredOn?.slice(0, 16).replace('T', ' ')} by {order.requester?.display ?? order.requester?.reference ?? '—'} · to{' '}
            {order.performer?.[0]?.display ?? '—'}
            {order.code?.coding?.[0] ? ` · LOINC ${order.code.coding[0].code}` : ''}
          </Text>
          {order.note?.map((n, i) => (
            <Text key={i} size="xs">
              {n.text}
            </Text>
          ))}
        </div>
        <Stack gap={4} align="flex-end">
          <Badge color={order.status === 'completed' ? 'green' : order.status === 'revoked' ? 'gray' : 'blue'} variant="light">
            {statusText}
          </Badge>
          {report && (
            <Text size="xs">
              Report: <strong>{report.status}</strong> (see Results tab)
            </Text>
          )}
          {order.status === 'active' && !report && !cancelling && (
            <Button size="compact-xs" variant="subtle" color="red" onClick={() => setCancelling(true)}>
              Cancel order
            </Button>
          )}
        </Stack>
      </Group>
      {cancelling && (
        <Stack gap="xs" mt="xs">
          <Alert color="gray" p="xs">
            Cancelling marks the order "revoked" — it stays on record.
          </Alert>
          <Group align="flex-end">
            <TextInput label="Reason" value={reason} onChange={(e) => setReason(e.currentTarget.value)} style={{ flex: 1 }} />
            <Button size="xs" variant="subtle" onClick={() => setCancelling(false)}>
              Keep
            </Button>
            <Button size="xs" color="red" loading={busy} disabled={!reason.trim()} onClick={doCancel}>
              Cancel order
            </Button>
          </Group>
        </Stack>
      )}
    </Paper>
  );
}
