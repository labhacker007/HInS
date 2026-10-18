import { useEffect, useState, useCallback } from 'react';
import { Stack, Title, Text, Button, Loader, Divider, TextInput, MultiSelect, Select, Group } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { ConsentPurpose, ConsentType } from '@hins/shared';
import { useMedplumProfile } from '@medplum/react';
import { createConsent, listConsentHistory, revokeConsent, type ConsentApiRecord } from '../../lib/consentApi.js';
import { ConsentHistoryList } from '../../components/ConsentHistoryList.js';

const SCOPE_OPTIONS = ['OPDRecord', 'LabReport', 'Prescription', 'DischargeSummary', 'Imaging'];
const PURPOSE_OPTIONS: ConsentPurpose[] = ['self_use', 'treatment', 'payment', 'research'];
const TYPE_OPTIONS: ConsentType[] = ['data_sharing', 'research', 'marketing'];

/**
 * Patient-controlled consent management — docs/PLATFORM_BLUEPRINT.md §04.
 * Every grant here is visible and revocable in one action (§04.5). This is
 * the patient's half of the flow; the clinician-side "request" button in
 * PatientDetail.tsx is the other half, with the same simplification noted
 * there (no HIE-CM approval round trip yet, §16).
 */
export function MyConsents() {
  const profile = useMedplumProfile();
  const [consents, setConsents] = useState<ConsentApiRecord[] | undefined>();
  const [revokingId, setRevokingId] = useState<string | undefined>();

  const reload = useCallback(() => {
    if (!profile?.id) return;
    listConsentHistory(profile.id).then(setConsents);
  }, [profile?.id]);

  useEffect(reload, [reload]);

  async function handleRevoke(consentId: string) {
    setRevokingId(consentId);
    try {
      await revokeConsent(consentId);
      notifications.show({ message: 'Consent revoked', color: 'green' });
      reload();
    } catch (err) {
      notifications.show({ message: String(err), color: 'red' });
    } finally {
      setRevokingId(undefined);
    }
  }

  return (
    <Stack maw={640}>
      <Title order={3}>My Consents</Title>
      <Text size="sm" c="dimmed">
        Who has access to your records, and for how long — including past consents
        you've revoked or that have expired.
      </Text>

      {consents === undefined ? (
        <Loader size="sm" />
      ) : (
        <ConsentHistoryList history={consents} onRevoke={handleRevoke} revokingId={revokingId} />
      )}

      <Divider my="sm" />
      <GrantConsentForm patientId={profile?.id} onGranted={reload} />
    </Stack>
  );
}

function GrantConsentForm({ patientId, onGranted }: { patientId: string | undefined; onGranted: () => void }) {
  const [requesterName, setRequesterName] = useState('');
  const [type, setType] = useState<ConsentType>('data_sharing');
  const [purpose, setPurpose] = useState<ConsentPurpose>('treatment');
  const [scope, setScope] = useState<string[]>([]);
  const [days, setDays] = useState('30');
  const [saving, setSaving] = useState(false);

  const canSave = patientId && requesterName.trim() && scope.length > 0;

  async function handleGrant() {
    if (!canSave) return;
    setSaving(true);
    try {
      const start = new Date();
      const expiry = new Date(start.getTime() + Number(days) * 24 * 60 * 60 * 1000);
      await createConsent({
        type,
        grantorPatientId: patientId!,
        scope,
        purposeCode: purpose,
        requesterId: requesterName.trim().toLowerCase().replace(/\s+/g, '-'),
        requesterDisplayName: requesterName.trim(),
        validityStart: start.toISOString(),
        validityExpiry: expiry.toISOString(),
      });
      setRequesterName('');
      setScope([]);
      notifications.show({ message: 'Consent granted', color: 'green' });
      onGranted();
    } catch (err) {
      notifications.show({ message: String(err), color: 'red' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Stack gap="xs">
      <Title order={5}>Grant new consent</Title>
      <TextInput
        label="Who are you sharing with?"
        placeholder="e.g. Apollo Referral Desk"
        value={requesterName}
        onChange={(e) => setRequesterName(e.currentTarget.value)}
      />
      <Group grow>
        <Select label="Type" data={TYPE_OPTIONS} value={type} onChange={(v) => setType((v as ConsentType) ?? 'data_sharing')} />
        <Select
          label="Purpose"
          data={PURPOSE_OPTIONS}
          value={purpose}
          onChange={(v) => setPurpose((v as ConsentPurpose) ?? 'treatment')}
        />
        <TextInput label="Valid for (days)" type="number" value={days} onChange={(e) => setDays(e.currentTarget.value)} />
      </Group>
      <MultiSelect label="What can they see?" data={SCOPE_OPTIONS} value={scope} onChange={setScope} />
      <Group justify="flex-end">
        <Button size="sm" disabled={!canSave} loading={saving} onClick={handleGrant}>
          Grant access
        </Button>
      </Group>
    </Stack>
  );
}
