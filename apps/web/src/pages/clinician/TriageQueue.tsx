import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Stack, Group, Title, Table, Badge, Button, Select, Text, Loader, Switch, Paper } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { Encounter } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { deptName } from '../../lib/hospital.js';
import { useDepartments, deptCodeOf } from '../../lib/useDepartments.js';
import { ACUITY_LEVELS, HINS_ENCOUNTER_TYPE, acuityOf, queueStatus, sortTriageQueue } from '../../lib/clinical.js';
import { TriageForm, TRIAGE_DEPARTMENTS } from '../../components/TriageForm.js';

/**
 * Triage queue (/triage). Lists triaged visits (Encounter type
 * triage-visit), most acute first then longest-waiting, filtered by
 * department. Status is the Encounter's own status: triaged = waiting,
 * in-progress = in consult, finished = done; buttons are status
 * transitions only (non-destructive, same convention as the rest of the
 * app). "Start consult" moves the visit to in-progress and opens the
 * patient chart — the Consult note tab there pre-selects this encounter.
 *
 * Known gap, stated plainly: no live push — the queue refreshes on a
 * 30 s poll and after local actions (Medplum subscriptions over websocket
 * would be the real fix). Queue shows the last 48 h of visits only.
 */
const STATUS_BADGE: Record<string, { label: string; color: string }> = {
  waiting: { label: 'Waiting', color: 'yellow' },
  'in-consult': { label: 'In consult', color: 'blue' },
  done: { label: 'Done', color: 'gray' },
  other: { label: 'Other', color: 'gray' },
};

export function TriageQueue() {
  const medplum = useMedplum();
  const navigate = useNavigate();
  const depts = useDepartments();
  const [deptFilter, setDeptFilter] = useState<string>('all');
  const [showDone, setShowDone] = useState(false);
  const [queue, setQueue] = useState<Encounter[] | undefined>();
  const [busy, setBusy] = useState<string | undefined>();

  const reload = useCallback(() => {
    if (!depts) return;
    const since = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    const statuses = showDone ? 'arrived,triaged,in-progress,finished' : 'arrived,triaged,in-progress';
    const params: Record<string, string> = {
      type: `${HINS_ENCOUNTER_TYPE}|triage-visit`,
      status: statuses,
      date: `ge${since}`,
      _count: '200',
    };
    if (deptFilter !== 'all' && depts[deptFilter]?.id) params['service-provider'] = `Organization/${depts[deptFilter].id}`;
    medplum
      .search('Encounter', params, { cache: 'reload' })
      .then((b) => setQueue(sortTriageQueue((b.entry ?? []).map((e) => e.resource as Encounter))))
      .catch((err) => notifications.show({ message: String(err), color: 'red' }));
  }, [medplum, depts, deptFilter, showDone]);

  useEffect(() => {
    reload();
    const t = setInterval(reload, 30000);
    return () => clearInterval(t);
  }, [reload]);

  async function transition(enc: Encounter, status: Encounter['status']) {
    if (!enc.id) return;
    setBusy(enc.id);
    try {
      const fresh = await medplum.readResource('Encounter', enc.id, { cache: 'reload' });
      const updated = await medplum.updateResource<Encounter>({
        ...fresh,
        status,
        period: status === 'finished' ? { ...fresh.period, end: new Date().toISOString() } : fresh.period,
      });
      if (status === 'in-progress') {
        const pid = updated.subject?.reference?.split('/')[1];
        if (pid) navigate(`/patients/${pid}?encounter=${updated.id}`);
      }
      reload();
    } catch (err) {
      notifications.show({ message: String(err), color: 'red' });
    } finally {
      setBusy(undefined);
    }
  }

  const deptById = (ref?: string) => {
    const id = ref?.split('/')[1];
    const org = depts && Object.values(depts).find((o) => o.id === id);
    return org ? deptName(deptCodeOf(org) ?? '') : '—';
  };

  return (
    <Stack>
      <Group justify="space-between">
        <Group gap="sm">
          <Title order={3}>Triage</Title>
          <Button component={Link} to="/referrals" variant="subtle" size="xs">
            Referral inbox →
          </Button>
        </Group>
        <Group>
          <Select
            data={[{ value: 'all', label: 'All triage departments' }, ...TRIAGE_DEPARTMENTS.map((c) => ({ value: c, label: deptName(c) }))]}
            value={deptFilter}
            onChange={(v) => setDeptFilter(v ?? 'all')}
            allowDeselect={false}
            w={240}
          />
          <Switch label="Show done" checked={showDone} onChange={(e) => setShowDone(e.currentTarget.checked)} />
        </Group>
      </Group>

      {depts === undefined ? <Loader size="sm" /> : <TriageForm depts={depts} onCreated={reload} />}

      <Paper withBorder p="md">
        {queue === undefined ? (
          <Loader size="sm" />
        ) : queue.length === 0 ? (
          <Text c="dimmed">Queue is empty.</Text>
        ) : (
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Acuity</Table.Th>
                <Table.Th>Patient</Table.Th>
                <Table.Th>Chief complaint</Table.Th>
                <Table.Th>Department</Table.Th>
                <Table.Th>Arrived</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {queue.map((e) => {
                const a = acuityOf(e);
                const lvl = ACUITY_LEVELS.find((x) => x.level === a);
                const st = queueStatus(e);
                const pid = e.subject?.reference?.split('/')[1];
                const waitedMin = e.period?.start ? Math.round((Date.now() - new Date(e.period.start).getTime()) / 60000) : undefined;
                return (
                  <Table.Tr key={e.id}>
                    <Table.Td>
                      <Badge color={lvl?.color ?? 'gray'}>{lvl ? `ESI ${a}` : '—'}</Badge>
                    </Table.Td>
                    <Table.Td>{pid ? <Link to={`/patients/${pid}`}>{e.subject?.display ?? e.subject?.reference}</Link> : '—'}</Table.Td>
                    <Table.Td>{e.reasonCode?.[0]?.text ?? '—'}</Table.Td>
                    <Table.Td>{e.serviceProvider?.display ?? deptById(e.serviceProvider?.reference)}</Table.Td>
                    <Table.Td>
                      {e.period?.start ? new Date(e.period.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}
                      {st === 'waiting' && waitedMin !== undefined && (
                        <Text span size="xs" c="dimmed">
                          {' '}
                          ({waitedMin} min)
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Badge variant="light" color={STATUS_BADGE[st].color}>
                        {STATUS_BADGE[st].label}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4} justify="flex-end">
                        {st === 'waiting' && (
                          <Button size="xs" loading={busy === e.id} onClick={() => transition(e, 'in-progress')}>
                            Start consult
                          </Button>
                        )}
                        {st === 'in-consult' && (
                          <>
                            <Button size="xs" variant="light" onClick={() => pid && navigate(`/patients/${pid}?encounter=${e.id}`)}>
                              Open chart
                            </Button>
                            <Button size="xs" variant="subtle" loading={busy === e.id} onClick={() => transition(e, 'finished')}>
                              Mark done
                            </Button>
                          </>
                        )}
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        )}
      </Paper>
    </Stack>
  );
}
