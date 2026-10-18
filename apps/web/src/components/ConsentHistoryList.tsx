import { Paper, Group, Text, Badge, Button, Stack, Title } from '@mantine/core';
import type { ConsentApiRecord } from '../lib/consentApi.js';

/**
 * Buckets a patient's full consent history (consentApi.listConsentHistory)
 * into Active / Revoked / Expired and renders all three — not just active
 * grants. Shared by the patient portal (pages/patient/MyConsents.tsx) and
 * the clinician view (pages/clinician/PatientDetail.tsx) so "see revoked
 * consents too" means the same thing, and shows the same data, in both
 * places.
 */
export function ConsentHistoryList({
  history,
  onRevoke,
  revokingId,
}: {
  history: ConsentApiRecord[];
  /** Omit for a read-only view (clinician) — Revoke only makes sense from
   * the patient's own portal. */
  onRevoke?: (consentId: string) => void;
  revokingId?: string;
}) {
  const now = Date.now();
  const active = history.filter((c) => c.status === 'granted' && !c.revokes && new Date(c.validityExpiry).getTime() > now);
  const revoked = history.filter((c) => c.status === 'revoked');
  const expired = history.filter((c) => c.status === 'granted' && !c.revokes && new Date(c.validityExpiry).getTime() <= now);

  if (history.length === 0) {
    return <Text c="dimmed">No consent records for this patient.</Text>;
  }

  return (
    <Stack gap="lg">
      <ConsentGroup title="Active" items={active} color="green" onRevoke={onRevoke} revokingId={revokingId} emptyText="None active." />
      <ConsentGroup title="Revoked" items={revoked} color="red" emptyText="None revoked." dateLabel="Revoked" />
      <ConsentGroup title="Expired" items={expired} color="gray" emptyText="None expired." dateLabel="Expired" />
    </Stack>
  );
}

function ConsentGroup({
  title,
  items,
  color,
  onRevoke,
  revokingId,
  emptyText,
  dateLabel,
}: {
  title: string;
  items: ConsentApiRecord[];
  color: string;
  onRevoke?: (consentId: string) => void;
  revokingId?: string;
  emptyText: string;
  dateLabel?: string;
}) {
  return (
    <div>
      <Title order={6} mb={6}>
        {title} ({items.length})
      </Title>
      {items.length === 0 ? (
        <Text size="sm" c="dimmed">
          {emptyText}
        </Text>
      ) : (
        <Stack gap="sm">
          {items.map((c) => (
            <Paper key={c.consentId} withBorder p="sm">
              <Group justify="space-between" align="flex-start">
                <div>
                  <Group gap="xs" mb={4}>
                    <Text fw={600}>{c.requesterDisplayName}</Text>
                    <Badge size="sm" variant="light" color={color}>
                      {c.type}
                    </Badge>
                    <Badge size="sm" variant="outline">
                      {c.purposeCode}
                    </Badge>
                  </Group>
                  <Text size="sm" c="dimmed">
                    Scope: {c.scope.join(', ')}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {dateLabel ?? 'Expires'} {new Date(dateLabel ? c.createdAt : c.validityExpiry).toLocaleString()}
                  </Text>
                </div>
                {onRevoke && (
                  <Button size="xs" color="red" variant="light" loading={revokingId === c.consentId} onClick={() => onRevoke(c.consentId)}>
                    Revoke
                  </Button>
                )}
              </Group>
            </Paper>
          ))}
        </Stack>
      )}
    </div>
  );
}
