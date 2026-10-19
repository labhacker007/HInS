import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Stack, Group, Title, Select, SegmentedControl, Button, Text, Loader } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { ServiceRequest } from '@medplum/fhirtypes';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import { formatHumanName } from '../../lib/fhirFormat.js';
import { useDepartments } from '../../lib/useDepartments.js';
import { REFERRAL_CATEGORY, acceptReferral, completeReferral, referralState } from '../../lib/clinical.js';
import { REFERRAL_TARGETS, ReferralCard } from '../../components/ReferralPanel.js';
import { DictationTextInput } from '../../components/DictationTextarea.js';

/**
 * Department referral inbox (/referrals): every referral addressed to
 * the chosen department (ServiceRequest.performer = that department's
 * Organization). Accept appends the signed-in practitioner to performer[]
 * (see lib/clinical.ts header for why that's not a status), Complete sets
 * status active -> completed with a note. Non-destructive throughout.
 *
 * Known gap, stated plainly: the department picker is a free choice —
 * it is not yet defaulted from / restricted to the signed-in user's
 * PractitionerRole department; server-side scoping is Medplum
 * AccessPolicy's job (see hospital.ts), not this page's.
 */
const DEPT_KEY = 'hins.referralInbox.dept';

export function ReferralInbox() {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const depts = useDepartments();
  const [dept, setDept] = useState<string | null>(() => {
    try {
      return localStorage.getItem(DEPT_KEY);
    } catch {
      return null;
    }
  });
  const [filter, setFilter] = useState<'open' | 'completed' | 'all'>('open');
  const [list, setList] = useState<ServiceRequest[] | undefined>();
  const [busy, setBusy] = useState<string | undefined>();
  const [outcome, setOutcome] = useState<Record<string, string>>({});

  const me = profile?.id ? { reference: `${profile.resourceType}/${profile.id}`, display: formatHumanName(profile.name as any) } : undefined;

  const reload = useCallback(() => {
    const org = dept ? depts?.[dept] : undefined;
    if (!org?.id) {
      setList(undefined);
      return;
    }
    const cat = REFERRAL_CATEGORY.coding?.[0];
    medplum
      .searchResources(
        'ServiceRequest',
        {
          performer: `Organization/${org.id}`,
          category: `${cat?.system}|${cat?.code}`,
          status: filter === 'open' ? 'active' : filter === 'completed' ? 'completed' : 'active,completed,revoked',
          _sort: '-authored',
          _count: 100,
        },
        { cache: 'reload' }
      )
      .then(setList)
      .catch((err) => notifications.show({ message: String(err), color: 'red' }));
  }, [medplum, depts, dept, filter]);
  useEffect(reload, [reload]);

  async function act(sr: ServiceRequest, action: 'accept' | 'complete') {
    if (!sr.id) return;
    setBusy(sr.id);
    try {
      const fresh = await medplum.readResource('ServiceRequest', sr.id, { cache: 'reload' });
      const now = new Date().toISOString();
      if (action === 'accept') {
        if (!me) throw new Error('No signed-in practitioner');
        if (referralState(fresh) !== 'new') throw new Error('Referral was already accepted or closed by someone else — refreshed.');
        await medplum.updateResource(acceptReferral(fresh, me, now));
      } else {
        if (fresh.status !== 'active') throw new Error('Referral is no longer active — refreshed.');
        await medplum.updateResource(completeReferral(fresh, me, now, outcome[sr.id]));
      }
      reload();
    } catch (err) {
      notifications.show({ message: String(err), color: 'red' });
      reload();
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <Stack>
      <Group justify="space-between">
        <Group gap="sm">
          <Title order={3}>Referral inbox</Title>
          <Button component={Link} to="/triage" variant="subtle" size="xs">
            ← Triage queue
          </Button>
        </Group>
        <Group>
          <Select
            placeholder="Choose department…"
            data={REFERRAL_TARGETS.map((d) => ({ value: d.code, label: d.name }))}
            value={dept}
            onChange={(v) => {
              setDept(v);
              try {
                if (v) localStorage.setItem(DEPT_KEY, v);
              } catch {
                /* per-viewer convenience only */
              }
            }}
            w={260}
          />
          <SegmentedControl
            value={filter}
            onChange={(v) => setFilter(v as typeof filter)}
            data={[
              { value: 'open', label: 'Open' },
              { value: 'completed', label: 'Completed' },
              { value: 'all', label: 'All' },
            ]}
          />
        </Group>
      </Group>
      {!dept ? (
        <Text c="dimmed">Choose a department to see referrals addressed to it.</Text>
      ) : depts === undefined || list === undefined ? (
        <Loader size="sm" />
      ) : list.length === 0 ? (
        <Text c="dimmed">No referrals.</Text>
      ) : (
        list.map((sr) => {
          const st = referralState(sr);
          const pid = sr.subject?.reference?.split('/')[1];
          return (
            <ReferralCard key={sr.id} sr={sr}>
              <Stack gap={4} align="flex-end">
                {pid && (
                  <Button size="xs" variant="subtle" component={Link} to={`/patients/${pid}`}>
                    Open chart
                  </Button>
                )}
                {st === 'new' && (
                  <Button size="xs" loading={busy === sr.id} onClick={() => act(sr, 'accept')}>
                    Accept
                  </Button>
                )}
                {st === 'accepted' && (
                  <>
                    <DictationTextInput
                      size="xs"
                      placeholder="Outcome (optional)"
                      value={outcome[sr.id!] ?? ''}
                      onValueChange={(v) => setOutcome((o) => ({ ...o, [sr.id!]: v }))}
                      patientId={pid}
                    />
                    <Button size="xs" color="green" loading={busy === sr.id} onClick={() => act(sr, 'complete')}>
                      Complete
                    </Button>
                  </>
                )}
              </Stack>
            </ReferralCard>
          );
        })
      )}
    </Stack>
  );
}
