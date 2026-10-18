import { Paper, Group, Text, Badge, Button, Stack, Title } from '@mantine/core';
import type { ConsentApiRecord } from '../lib/consentApi.js';

/**
 * Buckets a patient's full consent history (consentApi.listConsentHistory)
 * into Pending / Active / Revoked / Expired and renders all four — not
 * just active grants. Shared by the patient portal (pages/patient/
 * MyConsents.tsx) and the clinician view (pages/clinician/PatientDetail.
 * tsx) so "see revoked consents too" means the same thing, and shows the
 * same data, in both places.
 *
 * Pending items (§04.2/§16 "Consent approval round trip") only get
 * Approve/Deny buttons when onApprove/onDeny are passed — MyConsents.tsx
 * (the patient's own view) passes them; PatientDetail.tsx (clinician,
 * read-only here) never does, same pattern as onRevoke below.
 */
export function ConsentHistoryList({
  history,
  onRevoke,
  revokingId,
  onApprove,
  onDeny,
  decidingId,
}: {
  history: ConsentApiRecord[];
  /** Omit for a read-only view (clinician) — Revoke only makes sense from
   * the patient's own portal. */
  onRevoke?: (consentId: string) => void;
  revokingId?: string;
  /** Patient-portal only — see file header. */
  onApprove?: (consentId: string) => void;
  onDeny?: (consentId: string) => void;
  decidingId?: string;
}) {
  const now = Date.now();
  const pending = history.filter((c) => c.status === 'pending');
  const active = history.filter((c) => c.status === 'granted' && !c.revokes && new Date(c.validityExpiry).getTime() > now);
  const revoked = history.filter((c) => c.status === 'revoked');
  const expired = history.filter((c) => c.status === 'granted' && !c.revokes && new Date(c.validityExpiry).getTime() <= now);

  if (history.length === 0) {
    return <Text c="dimmed">No consent records for this patient.</Text>;
  }

  return (
    <Stack gap="lg">
      <ConsentGroup
        title="Pending approval"
        items={pending}
        color="yellow"
        onApprove={onApprove}
        onDeny={onDeny}
        decidingId={decidingId}
        emptyText="Nothing awaiting your approval."
      />
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
  onApprove,
  onDeny,
  decidingId,
  emptyText,
  dateLabel,
}: {
  title: string;
  items: ConsentApiRecord[];
  color: string;
  onRevoke?: (consentId: string) => void;
  revokingId?: string;
  onApprove?: (consentId: string) => void;
  onDeny?: (consentId: string) => void;
  decidingId?: string;
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
                  {c.statusNote && (
                    <Text size="xs" c="dimmed" fs="italic">
                      {c.statusNote}
                    </Text>
                  )}
                </div>
                {onRevoke && (
                  <Button size="xs" color="red" variant="light" loading={revokingId === c.consentId} onClick={() => onRevoke(c.consentId)}>
                    Revoke
                  </Button>
                )}
                {(onApprove || onDeny) && (
                  <Group gap="xs">
                    {onApprove && (
                      <Button
                        size="xs"
                        color="green"
                        variant="light"
                        loading={decidingId === c.consentId}
                        onClick={() => onApprove(c.consentId)}
                      >
                        Approve
                      </Button>
                    )}
                    {onDeny && (
                      <Button size="xs" color="red" variant="light" loading={decidingId === c.consentId} onClick={() => onDeny(c.consentId)}>
                        Deny
                      </Button>
                    )}
                  </Group>
                )}
              </Group>
            </Paper>
          ))}
        </Stack>
      )}
    </div>
  );
}
