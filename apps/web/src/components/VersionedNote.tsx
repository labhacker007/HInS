import { useState } from 'react';
import { Paper, Group, Text, Badge, Textarea, Button, Stack, Collapse, Divider, Loader } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { Bundle, DocumentReference } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { recordEditEvent } from '../lib/auditApi.js';

/**
 * A clinical note with inline edit and full version history — clinician
 * app only (apps/web/src/pages/clinician/). Never imported into the
 * patient portal: patients see their notes read-only
 * (pages/patient/MyRecords.tsx), consistent with normal EHR UX; the edit
 * history itself is a clinician/admin-facing audit trail, not currently
 * shown to the patient — a scoping choice, not an oversight.
 *
 * "Who did what and when": Medplum does NOT auto-populate meta.author on
 * writes (verified directly against this running instance before writing
 * this component — a client-supplied meta.author is silently stripped,
 * since `meta` is server-controlled). DocumentReference.author is a
 * normal top-level FHIR field instead, not under `meta`, so it persists
 * like any other data and is preserved per-version in history. Every
 * save here sets it to the signed-in practitioner. "When" is
 * meta.lastUpdated, which Medplum does set correctly on every version.
 */
export function VersionedNote({
  note,
  patientId,
  onSaved,
}: {
  note: DocumentReference;
  patientId: string;
  onSaved: () => void;
}) {
  const medplum = useMedplum();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<Bundle<DocumentReference> | undefined>();

  const currentText = decodeContent(note);
  const author = note.author?.[0]?.display ?? 'Unknown';

  function startEdit() {
    setDraft(currentText);
    setEditing(true);
  }

  async function saveEdit() {
    if (!note.id) return;
    setSaving(true);
    try {
      const profile = medplum.getProfile();
      const editorId = profile ? `${profile.resourceType}/${profile.id}` : undefined;
      const editorName = profile ? profileName(profile) : undefined;
      const previousAuthor = note.author?.[0];
      const updated: DocumentReference = {
        ...note,
        author: editorId && editorName ? [{ reference: editorId, display: editorName }] : note.author,
        content: [{ attachment: { contentType: 'text/plain', data: btoa(draft) } }],
      };
      await medplum.updateResource(updated);
      notifications.show({ message: 'Note updated', color: 'green' });
      setEditing(false);
      onSaved();
      if (profile?.id && editorName) {
        recordEditEvent({
          resourceType: 'DocumentReference',
          resourceId: note.id,
          patientId,
          action: 'update',
          actorId: profile.id,
          actorName: editorName,
          summary: `Corrected a ${note.type?.text ?? 'clinical'} note`,
          originalAuthorId: previousAuthor?.reference?.split('/')[1],
          originalAuthorName: previousAuthor?.display,
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
    if (next && !history && note.id) {
      const h = await medplum.readHistory('DocumentReference', note.id);
      setHistory(h);
    }
  }

  return (
    <Paper withBorder p="sm">
      <Group justify="space-between" mb={4}>
        <Badge size="sm" variant="light">
          {note.type?.text ?? 'Note'}
        </Badge>
        <Text size="xs" c="dimmed">
          {note.date?.slice(0, 16).replace('T', ' ')}
        </Text>
      </Group>

      {editing ? (
        <Stack gap="xs">
          <Textarea value={draft} onChange={(e) => setDraft(e.currentTarget.value)} minRows={4} autosize />
          <Group justify="flex-end" gap="xs">
            <Button size="xs" variant="subtle" onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </Button>
            <Button size="xs" loading={saving} onClick={saveEdit}>
              Save correction
            </Button>
          </Group>
        </Stack>
      ) : (
        <>
          <Text style={{ whiteSpace: 'pre-wrap' }}>{currentText}</Text>
          <Group justify="space-between" mt={8}>
            <Text size="xs" c="dimmed">
              Last edited by {author}
              {note.meta?.lastUpdated ? ` · ${note.meta.lastUpdated.slice(0, 16).replace('T', ' ')}` : ''}
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
                        {r.author?.[0]?.display ?? 'Unknown'}
                        {i === 0 ? ' (current)' : ''}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {r.meta?.lastUpdated?.slice(0, 16).replace('T', ' ')}
                      </Text>
                    </Group>
                    <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                      {decodeContent(r)}
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

function decodeContent(note: DocumentReference): string {
  const data = note.content?.[0]?.attachment?.data;
  return data ? atob(data) : '(empty)';
}

function profileName(profile: { resourceType: string; name?: Array<{ given?: string[]; family?: string }> }): string {
  const n = profile.name?.[0];
  if (!n) return profile.resourceType;
  return [n.given?.join(' '), n.family].filter(Boolean).join(' ');
}
