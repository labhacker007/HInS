import { useState } from 'react';
import { Paper, Group, Text, TextInput, Button, Stack, Collapse, Divider, Loader } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { Bundle, MedicationRequest } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { recordEditEvent } from '../lib/auditApi.js';
import { PharmacyPanel } from './PharmacyDispense.js';

/**
 * A prescription with inline edit and full version history — the same
 * pattern as VersionedNote.tsx, for mistaken-entry corrections on
 * MedicationRequest.
 *
 * Attribution: MedicationRequest has no field shaped like
 * DocumentReference.author, and (verified directly against this running
 * instance, same as for notes) a client-supplied meta.author is silently
 * discarded. Uses a custom extension instead --
 * https://hins.example/fhir/StructureDefinition/last-modified-by --
 * which, also verified directly, persists per-version like any other
 * resource data. `requester` is left untouched by edits on purpose: it's
 * FHIR's defined field for "who ordered this," a different fact from
 * "who last corrected a typo in it," and conflating them would lose the
 * original prescriber of record for a controlled-substance-style audit
 * trail.
 *
 * Also renders `PharmacyPanel` (PharmacyDispense.tsx) directly under each
 * prescription — dispensing/administration is read right alongside the
 * order it's against, not a separate page. See that file's own header
 * for the full pharmacy-dispensing design (§13/§13a "02a").
 */
const LAST_MODIFIED_BY_EXT = 'https://hins.example/fhir/StructureDefinition/last-modified-by';

function lastModifiedBy(mr: MedicationRequest): string {
  const ext = mr.extension?.find((e) => e.url === LAST_MODIFIED_BY_EXT);
  return ext?.valueReference?.display ?? mr.requester?.display ?? 'Unknown';
}

export function VersionedRx({
  rx,
  patientId,
  onSaved,
}: {
  rx: MedicationRequest;
  patientId: string;
  onSaved: () => void;
}) {
  const medplum = useMedplum();
  const [editing, setEditing] = useState(false);
  const [medication, setMedication] = useState('');
  const [dosage, setDosage] = useState('');
  const [saving, setSaving] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<Bundle<MedicationRequest> | undefined>();

  function startEdit() {
    setMedication(rx.medicationCodeableConcept?.text ?? '');
    setDosage(rx.dosageInstruction?.[0]?.text ?? '');
    setEditing(true);
  }

  async function saveEdit() {
    if (!rx.id || !medication.trim()) return;
    setSaving(true);
    try {
      const profile = medplum.getProfile();
      const editorRef = profile ? { reference: `${profile.resourceType}/${profile.id}`, display: profileName(profile) } : undefined;
      const otherExtensions = (rx.extension ?? []).filter((e) => e.url !== LAST_MODIFIED_BY_EXT);
      const updated: MedicationRequest = {
        ...rx,
        extension: editorRef ? [...otherExtensions, { url: LAST_MODIFIED_BY_EXT, valueReference: editorRef }] : rx.extension,
        medicationCodeableConcept: { text: medication.trim() },
        dosageInstruction: dosage.trim() ? [{ text: dosage.trim() }] : undefined,
      };
      await medplum.updateResource(updated);
      notifications.show({ message: 'Prescription updated', color: 'green' });
      setEditing(false);
      onSaved();
      if (editorRef) {
        recordEditEvent({
          resourceType: 'MedicationRequest',
          resourceId: rx.id,
          patientId,
          action: 'update',
          actorId: editorRef.reference.split('/')[1],
          actorName: editorRef.display!,
          summary: `Corrected prescription: ${medication.trim()}`,
        }).catch(() => {
          /* alerting is best-effort — a failed notification must never block the save itself */
        });
      }
    } catch (err) {
      notifications.show({ message: String(err), color: 'red' });
    } finally {
      setSaving(false);
    }
  }

  async function toggleHistory() {
    const next = !historyOpen;
    setHistoryOpen(next);
    if (next && !history && rx.id) {
      setHistory(await medplum.readHistory('MedicationRequest', rx.id));
    }
  }

  return (
    <Paper withBorder p="sm">
      {editing ? (
        <Stack gap="xs">
          <TextInput label="Medication" value={medication} onChange={(e) => setMedication(e.currentTarget.value)} />
          <TextInput label="Dosage instructions" value={dosage} onChange={(e) => setDosage(e.currentTarget.value)} />
          <Group justify="flex-end" gap="xs">
            <Button size="xs" variant="subtle" onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </Button>
            <Button size="xs" loading={saving} disabled={!medication.trim()} onClick={saveEdit}>
              Save correction
            </Button>
          </Group>
        </Stack>
      ) : (
        <>
          <Text fw={600}>{rx.medicationCodeableConcept?.text}</Text>
          <Text size="sm" c="dimmed">
            {rx.dosageInstruction?.[0]?.text} · {rx.authoredOn?.slice(0, 10)}
          </Text>
          <Group justify="space-between" mt={8}>
            <Text size="xs" c="dimmed">
              Last edited by {lastModifiedBy(rx)}
              {rx.meta?.lastUpdated ? ` · ${rx.meta.lastUpdated.slice(0, 16).replace('T', ' ')}` : ''}
            </Text>
            <Group gap="xs">
              <Button size="compact-xs" variant="subtle" onClick={toggleHistory}>
                {historyOpen ? 'Hide history' : 'View history'}
              </Button>
              <Button size="compact-xs" variant="subtle" onClick={startEdit}>
                Edit
              </Button>
            </Group>
          </Group>
          {/* Pharmacy dispensing/administration -- a separate concern from
              the correction-history above (that's "fix a mistaken entry on
              this order"; this is "a real-world event happened against
              it"), kept in its own file (PharmacyDispense.tsx) and rendered
              right alongside the order it's against rather than a separate
              page -- see that file's header for the full design. */}
          <PharmacyPanel rx={rx} patientId={patientId} />
        </>
      )}

      <Collapse in={historyOpen}>
        <Divider my="sm" label="Version history" labelPosition="left" />
        {history === undefined ? (
          <Loader size="xs" />
        ) : (
          <Stack gap="xs">
            {[...history.entry!]
              .sort((a, b) => (b.resource!.meta!.lastUpdated! > a.resource!.meta!.lastUpdated! ? 1 : -1))
              .map((entry, i) => {
                const r = entry.resource!;
                return (
                  <Paper key={r.meta?.versionId ?? i} p="xs" bg="var(--mantine-color-gray-0)" withBorder>
                    <Group justify="space-between" mb={2}>
                      <Text size="xs" fw={600}>
                        {lastModifiedBy(r)}
                        {i === 0 ? ' (current)' : ''}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {r.meta?.lastUpdated?.slice(0, 16).replace('T', ' ')}
                      </Text>
                    </Group>
                    <Text size="sm">
                      {r.medicationCodeableConcept?.text} — {r.dosageInstruction?.[0]?.text}
                    </Text>
                  </Paper>
                );
              })}
          </Stack>
        )}
      </Collapse>
    </Paper>
  );
}

function profileName(profile: { resourceType: string; name?: Array<{ given?: string[]; family?: string }> }): string {
  const n = profile.name?.[0];
  if (!n) return profile.resourceType;
  return [n.given?.join(' '), n.family].filter(Boolean).join(' ');
}
