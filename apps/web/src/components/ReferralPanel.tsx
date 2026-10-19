import { useCallback, useEffect, useState } from 'react';
import { Stack, Group, Select, TextInput, Button, Text, Paper, Badge, Loader, Divider } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { Condition, Encounter, ServiceRequest } from '@medplum/fhirtypes';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import { formatHumanName } from '../lib/fhirFormat.js';
import { DEPARTMENTS } from '../lib/hospital.js';
import { useDepartments } from '../lib/useDepartments.js';
import { REFERRAL_CATEGORY, buildReferral, referralState, type ReferralPriority } from '../lib/clinical.js';

/**
 * Patient-chart "Referrals" tab: refer this patient to another department
 * (ServiceRequest, category SNOMED 3457005 Patient referral, performer =
 * department Organization) and see every referral for the patient with
 * its state. The receiving department works it from /referrals
 * (ReferralInbox.tsx). Departments that receive referrals = every
 * department except billing/administration.
 */
export const REFERRAL_TARGETS = DEPARTMENTS.filter((d) => d.code !== 'billing' && d.code !== 'administration');

export const REFERRAL_STATE_BADGE: Record<string, { label: string; color: string }> = {
  new: { label: 'New', color: 'yellow' },
  accepted: { label: 'Accepted', color: 'blue' },
  completed: { label: 'Completed', color: 'green' },
  revoked: { label: 'Revoked', color: 'gray' },
  other: { label: 'Other', color: 'gray' },
};

export function ReferralPanel({ patientId, patientName }: { patientId: string; patientName: string }) {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const depts = useDepartments();
  const [list, setList] = useState<ServiceRequest[] | undefined>();
  const [conditions, setConditions] = useState<Condition[]>([]);
  const [openEncounter, setOpenEncounter] = useState<Encounter | undefined>();
  const [to, setTo] = useState<string | null>(null);
  const [what, setWhat] = useState('');
  const [reason, setReason] = useState('');
  const [reasonCondition, setReasonCondition] = useState<string | null>(null);
  const [priority, setPriority] = useState<ReferralPriority>('routine');
  const [saving, setSaving] = useState(false);

  const reload = useCallback(() => {
    const cat = REFERRAL_CATEGORY.coding?.[0];
    medplum
      .searchResources('ServiceRequest', { subject: `Patient/${patientId}`, category: `${cat?.system}|${cat?.code}`, _sort: '-authored', _count: 50 }, { cache: 'reload' })
      .then(setList);
    medplum
      .searchResources('Condition', { subject: `Patient/${patientId}`, 'clinical-status': 'active', _count: 50 })
      .then((cs) => setConditions(cs.filter((c) => c.verificationStatus?.coding?.[0]?.code !== 'entered-in-error')));
    medplum
      .searchResources('Encounter', { subject: `Patient/${patientId}`, status: 'arrived,triaged,in-progress', _sort: '-date', _count: 1 })
      .then((e) => setOpenEncounter(e[0]));
  }, [medplum, patientId]);
  useEffect(reload, [reload]);

  async function handleCreate() {
    const org = to ? depts?.[to] : undefined;
    if (!org?.id || !what.trim()) return;
    setSaving(true);
    try {
      const cond = conditions.find((c) => c.id === reasonCondition);
      await medplum.createResource(
        buildReferral({
          patient: { reference: `Patient/${patientId}`, display: patientName },
          toDepartment: { reference: `Organization/${org.id}`, display: org.name },
          requester: profile?.id ? { reference: `${profile.resourceType}/${profile.id}`, display: formatHumanName(profile.name as any) } : undefined,
          encounter: openEncounter?.id ? { reference: `Encounter/${openEncounter.id}` } : undefined,
          what: what.trim(),
          reason: reason.trim(),
          reasonCondition: cond?.id ? { reference: `Condition/${cond.id}`, display: cond.code?.text } : undefined,
          priority,
          authoredOn: new Date().toISOString(),
        })
      );
      notifications.show({ message: `Referral sent to ${org.name}`, color: 'green' });
      setWhat('');
      setReason('');
      setReasonCondition(null);
      setPriority('routine');
      reload();
    } catch (err) {
      notifications.show({ message: String(err), color: 'red' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Stack>
      <Paper withBorder p="md" maw={720}>
        <Stack gap="xs">
          <Text fw={600}>Refer to department</Text>
          <Group grow>
            <Select
              label="To department"
              placeholder="Choose…"
              data={REFERRAL_TARGETS.map((d) => ({ value: d.code, label: d.name, disabled: !depts?.[d.code] }))}
              value={to}
              onChange={setTo}
            />
            <Select
              label="Priority"
              data={[
                { value: 'routine', label: 'Routine' },
                { value: 'urgent', label: 'Urgent' },
                { value: 'asap', label: 'ASAP' },
                { value: 'stat', label: 'STAT' },
              ]}
              value={priority}
              onChange={(v) => setPriority((v as ReferralPriority) ?? 'routine')}
              allowDeselect={false}
            />
          </Group>
          <TextInput label="Requested service" placeholder="e.g. Cardiology opinion, echocardiogram, diet counselling" value={what} onChange={(e) => setWhat(e.currentTarget.value)} required />
          <Group grow>
            <Select
              label="Linked diagnosis (optional)"
              placeholder={conditions.length ? 'Choose…' : 'No active diagnoses'}
              data={conditions.map((c) => ({ value: c.id as string, label: c.code?.text ?? c.code?.coding?.[0]?.display ?? c.id! }))}
              value={reasonCondition}
              onChange={setReasonCondition}
              clearable
            />
            <TextInput label="Reason" placeholder="Clinical question for the receiving team" value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
          </Group>
          <Group justify="space-between">
            <Text size="xs" c="dimmed">
              {openEncounter ? `Linked to open encounter of ${openEncounter.period?.start?.slice(0, 10)}` : 'No open encounter — referral not linked to one'}
            </Text>
            <Button loading={saving} disabled={!to || !what.trim()} onClick={handleCreate}>
              Send referral
            </Button>
          </Group>
        </Stack>
      </Paper>
      <Divider />
      {list === undefined ? <Loader size="sm" /> : list.length === 0 ? <Text c="dimmed">No referrals.</Text> : list.map((sr) => <ReferralCard key={sr.id} sr={sr} />)}
    </Stack>
  );
}

export function ReferralCard({ sr, children }: { sr: ServiceRequest; children?: React.ReactNode }) {
  const st = referralState(sr);
  return (
    <Paper withBorder p="sm">
      <Group justify="space-between" align="flex-start">
        <Stack gap={2}>
          <Group gap="xs">
            <Text fw={600}>{sr.code?.text ?? 'Referral'}</Text>
            <Badge size="sm" color={REFERRAL_STATE_BADGE[st].color}>
              {REFERRAL_STATE_BADGE[st].label}
            </Badge>
            {sr.priority && sr.priority !== 'routine' && (
              <Badge size="sm" color="red" variant="light">
                {sr.priority}
              </Badge>
            )}
          </Group>
          <Text size="sm">
            Patient: {sr.subject?.display ?? sr.subject?.reference} · To: {sr.performer?.[0]?.display ?? sr.performer?.[0]?.reference}
          </Text>
          <Text size="sm" c="dimmed">
            From {sr.requester?.display ?? '—'} · {sr.authoredOn ? new Date(sr.authoredOn).toLocaleString() : ''}
          </Text>
          {(sr.reasonCode?.[0]?.text || sr.reasonReference?.[0]?.display) && (
            <Text size="sm">Reason: {[sr.reasonReference?.[0]?.display, sr.reasonCode?.[0]?.text].filter(Boolean).join(' — ')}</Text>
          )}
          {sr.note?.map((n, i) => (
            <Text key={i} size="xs" c="dimmed">
              {n.time ? new Date(n.time).toLocaleString() : ''} · {n.text}
            </Text>
          ))}
        </Stack>
        {children}
      </Group>
    </Paper>
  );
}
