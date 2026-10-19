import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Stack, Group, Select, Textarea, Button, Text, Paper, Badge, ActionIcon, Checkbox, SegmentedControl } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { Condition, Encounter, Reference } from '@medplum/fhirtypes';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import { formatHumanName } from '../lib/fhirFormat.js';
import type { TermEntry } from '../lib/terminology.js';
import {
  buildConsultDocumentReference,
  buildDiagnosisCondition,
  queueStatus,
  type Soap,
  type VerificationStatus,
} from '../lib/clinical.js';
import { DictateButton } from './DictateButton.js';
import { SnomedPicker } from './SnomedPicker.js';

/**
 * Structured consult note (SOAP) — PatientDetail "Consult note" tab.
 *
 * Each section has its own DictateButton (browser speech-to-text,
 * DEV ONLY — see DictateButton.tsx header). Diagnoses are picked from the
 * SNOMED CT starter subset (SnomedPicker) and saved as Conditions with
 * SNOMED CT + ICD-10 codings, provisional/confirmed/differential
 * verification, linked to the encounter and recorder. The note itself is
 * a DocumentReference (LOINC 11488-4 Consult note) with a text/plain SOAP
 * body, so it shows up in the existing "Encounter notes" tab and keeps
 * VersionedNote's edit + version history working unchanged.
 *
 * Write order: Encounter (if new) -> Conditions -> DocumentReference ->
 * optional Encounter finish. Not atomic (Medplum transactions aren't
 * here); if a later write fails, the Conditions already created in this
 * save are flipped to verificationStatus 'entered-in-error' (never
 * deleted) so a retry doesn't leave duplicate live diagnoses.
 *
 * Known gap, stated plainly: no draft autosave — navigating away loses
 * an unsaved note. No AI summarisation of the dictation (blueprint §08).
 */
interface PickedDx {
  term: TermEntry;
  verification: VerificationStatus;
}

const NEW_ENCOUNTER = '__new__';
const SECTIONS: { key: keyof Soap; label: string; placeholder: string }[] = [
  { key: 'subjective', label: 'Subjective', placeholder: 'History of presenting illness, symptoms in patient’s words…' },
  { key: 'objective', label: 'Objective', placeholder: 'Exam findings, vitals, investigations…' },
  { key: 'assessment', label: 'Assessment', placeholder: 'Clinical impression; add coded diagnoses below…' },
  { key: 'plan', label: 'Plan', placeholder: 'Investigations, treatment, referrals, follow-up…' },
];

export function ConsultNote({ patientId, patientName, onSaved }: { patientId: string; patientName: string; onSaved: () => void }) {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const [searchParams] = useSearchParams();
  const [encounters, setEncounters] = useState<Encounter[] | undefined>();
  const [encounterId, setEncounterId] = useState<string>(searchParams.get('encounter') ?? NEW_ENCOUNTER);
  const [soap, setSoap] = useState<Soap>({ subjective: '', objective: '', assessment: '', plan: '' });
  const [dx, setDx] = useState<PickedDx[]>([]);
  const [closeEncounter, setCloseEncounter] = useState(false);
  const [saving, setSaving] = useState(false);

  const practitionerRef: Reference<any> | undefined = profile?.id
    ? { reference: `${profile.resourceType}/${profile.id}`, display: formatHumanName(profile.name as any) }
    : undefined;

  const loadEncounters = useCallback(() => {
    medplum
      .searchResources('Encounter', { subject: `Patient/${patientId}`, status: 'planned,arrived,triaged,in-progress', _sort: '-date', _count: 20 }, { cache: 'reload' })
      .then(setEncounters);
  }, [medplum, patientId]);
  useEffect(loadEncounters, [loadEncounters]);

  const encounterOptions = useMemo(
    () => [
      { value: NEW_ENCOUNTER, label: 'New OPD encounter (now)' },
      ...(encounters ?? []).map((e) => ({
        value: e.id as string,
        label: `${e.period?.start ? new Date(e.period.start).toLocaleString() : '—'} · ${e.serviceProvider?.display ?? e.class?.display ?? 'Encounter'} · ${e.reasonCode?.[0]?.text ?? ''} [${queueStatus(e)}]`,
      })),
    ],
    [encounters]
  );

  function append(key: keyof Soap, chunk: string) {
    setSoap((s) => ({ ...s, [key]: s[key] ? `${s[key]} ${chunk}` : chunk }));
  }

  async function insertTriageVitals() {
    if (encounterId === NEW_ENCOUNTER) return;
    const obs = await medplum.searchResources('Observation', { encounter: `Encounter/${encounterId}`, _count: 50 }, { cache: 'reload' });
    if (!obs.length) {
      notifications.show({ message: 'No observations recorded on this encounter', color: 'yellow' });
      return;
    }
    const lines = obs.map((o) => {
      const v = o.valueQuantity ? `${o.valueQuantity.value} ${o.valueQuantity.unit ?? ''}` : (o.valueInteger ?? o.valueString ?? '');
      return `${o.code?.text ?? o.code?.coding?.[0]?.display}: ${v}`.trim();
    });
    append('objective', `Triage: ${lines.join('; ')}.`);
  }

  async function handleSave() {
    setSaving(true);
    const now = new Date().toISOString();
    const patientRef = { reference: `Patient/${patientId}`, display: patientName };
    const createdConditions: Condition[] = [];
    try {
      let encId = encounterId;
      if (encId === NEW_ENCOUNTER) {
        const enc = await medplum.createResource<Encounter>({
          resourceType: 'Encounter',
          status: 'in-progress',
          class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'ambulatory' },
          subject: patientRef,
          participant: practitionerRef ? [{ individual: practitionerRef }] : undefined,
          period: { start: now },
        });
        encId = enc.id as string;
      }
      const encRef = { reference: `Encounter/${encId}` };
      for (const d of dx) {
        createdConditions.push(
          await medplum.createResource(
            buildDiagnosisCondition({ term: d.term, verification: d.verification, patient: patientRef, encounter: encRef, recorder: practitionerRef, recordedDate: now })
          )
        );
      }
      await medplum.createResource(
        buildConsultDocumentReference({
          soap,
          patient: patientRef,
          encounter: encRef,
          author: practitionerRef,
          conditions: createdConditions.map((c) => ({ reference: `Condition/${c.id}` })),
          date: now,
        })
      );
      if (closeEncounter) {
        const fresh = await medplum.readResource('Encounter', encId, { cache: 'reload' });
        await medplum.updateResource<Encounter>({ ...fresh, status: 'finished', period: { ...fresh.period, end: now } });
      }
      notifications.show({ message: `Consult note saved with ${createdConditions.length} coded diagnosis(es)`, color: 'green' });
      setSoap({ subjective: '', objective: '', assessment: '', plan: '' });
      setDx([]);
      setCloseEncounter(false);
      setEncounterId(closeEncounter ? NEW_ENCOUNTER : encId);
      loadEncounters();
      onSaved();
    } catch (err) {
      for (const c of createdConditions) {
        try {
          // con-5: clinicalStatus must be absent when entered-in-error (Medplum enforces it).
          const { clinicalStatus: _drop, ...rest } = c;
          await medplum.updateResource<Condition>({
            ...rest,
            verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: 'entered-in-error' }] },
          });
        } catch {
          /* best effort */
        }
      }
      notifications.show({ message: `Consult note not saved: ${String(err)}`, color: 'red' });
    } finally {
      setSaving(false);
    }
  }

  const hasContent = Object.values(soap).some((s) => s.trim()) || dx.length > 0;

  return (
    <Stack gap="sm">
      <Select
        label="Encounter"
        data={encounterOptions}
        value={encounterId}
        onChange={(v) => setEncounterId(v ?? NEW_ENCOUNTER)}
        allowDeselect={false}
        maw={640}
      />
      {SECTIONS.map((s) => (
        <Stack key={s.key} gap={4}>
          <Group justify="space-between">
            <Text fw={600} size="sm">
              {s.label}
            </Text>
            <Group gap="xs">
              {s.key === 'objective' && encounterId !== NEW_ENCOUNTER && (
                <Button size="compact-xs" variant="subtle" onClick={insertTriageVitals}>
                  Insert triage vitals
                </Button>
              )}
              <DictateButton
                patientId={patientId}
                requesterId={profile?.id}
                requesterName={practitionerRef?.display ?? ''}
                onTranscript={(t) => append(s.key, t)}
              />
            </Group>
          </Group>
          <Textarea
            placeholder={s.placeholder}
            autosize
            minRows={2}
            value={soap[s.key]}
            onChange={(e) => {
              const v = e.currentTarget.value;
              setSoap((prev) => ({ ...prev, [s.key]: v }));
            }}
          />
        </Stack>
      ))}

      <Paper withBorder p="sm">
        <Stack gap="xs">
          <SnomedPicker
            excludeCodes={dx.map((d) => d.term.snomed)}
            onPick={(term) => setDx((prev) => [...prev, { term, verification: 'provisional' }])}
          />
          {dx.length === 0 ? (
            <Text size="sm" c="dimmed">
              No coded diagnoses yet.
            </Text>
          ) : (
            dx.map((d, i) => (
              <Group key={d.term.snomed} justify="space-between" wrap="nowrap">
                <Group gap="xs">
                  <Text size="sm" fw={600}>
                    {d.term.display}
                  </Text>
                  <Badge size="sm" variant="outline">
                    SNOMED CT {d.term.snomed}
                  </Badge>
                  <Badge size="sm" variant="outline" title={d.term.icd10Display}>
                    ICD-10 {d.term.icd10}
                  </Badge>
                </Group>
                <Group gap="xs" wrap="nowrap">
                  <SegmentedControl
                    size="xs"
                    value={d.verification}
                    onChange={(v) => setDx((prev) => prev.map((x, j) => (j === i ? { ...x, verification: v as VerificationStatus } : x)))}
                    data={[
                      { value: 'provisional', label: 'Provisional' },
                      { value: 'differential', label: 'Differential' },
                      { value: 'confirmed', label: 'Confirmed' },
                    ]}
                  />
                  <ActionIcon variant="subtle" color="red" aria-label="Remove diagnosis" onClick={() => setDx((prev) => prev.filter((_, j) => j !== i))}>
                    ×
                  </ActionIcon>
                </Group>
              </Group>
            ))
          )}
        </Stack>
      </Paper>

      <Group justify="space-between">
        <Checkbox label="Close encounter (mark finished)" checked={closeEncounter} onChange={(e) => setCloseEncounter(e.currentTarget.checked)} />
        <Button loading={saving} disabled={!hasContent} onClick={handleSave}>
          Save consult note
        </Button>
      </Group>
    </Stack>
  );
}
