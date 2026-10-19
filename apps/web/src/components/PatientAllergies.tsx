import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Group, Loader, Paper, SegmentedControl, Select, SimpleGrid, Stack, Switch, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { AllergyIntolerance } from '@medplum/fhirtypes';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import { formatHumanName } from '../lib/fhirFormat.js';
import {
  allergyClinical,
  allergyVerification,
  buildAllergy,
  markAllergyEnteredInError,
  type AllergyCategory,
} from '../lib/patientProfile.js';
import { DictationTextInput } from './DictationTextarea.js';

/**
 * Allergies & intolerances (AllergyIntolerance) — list, add, and retract as
 * entered-in-error (never deleted; the prior version stays in _history).
 * Retraction removes clinicalStatus because FHIR invariant ait-2 forbids it
 * alongside entered-in-error — verified live: this Medplum rejects the update
 * otherwise.
 *
 * `category` narrows the list/form (PatientLifestyle embeds the food view).
 *
 * Known gap, stated plainly: the substance is free text — no licensed
 * substance terminology (SNOMED CT substance hierarchy / RxNorm / an Indian
 * drug master) is wired up, so allergy-vs-prescription cross-checking cannot
 * be automated yet.
 */
const CRIT_COLOR: Record<string, string> = { high: 'red', low: 'yellow', 'unable-to-assess': 'gray' };

export function PatientAllergies({ patientId, category }: { patientId: string; category?: AllergyCategory }) {
  const medplum = useMedplum();
  const [list, setList] = useState<AllergyIntolerance[] | undefined>();
  const [showRetracted, setShowRetracted] = useState(false);

  const load = useCallback(() => {
    medplum
      .searchResources(
        'AllergyIntolerance',
        { patient: `Patient/${patientId}`, ...(category ? { category } : {}), _sort: '-_lastUpdated', _count: 100 },
        { cache: 'reload' },
      )
      .then(setList)
      .catch((err) => notifications.show({ message: String(err), color: 'red' }));
  }, [medplum, patientId, category]);
  useEffect(load, [load]);

  async function retract(a: AllergyIntolerance) {
    if (!window.confirm(`Mark "${a.code?.text}" as entered in error? It stays in the record history.`)) return;
    try {
      const fresh = await medplum.readResource('AllergyIntolerance', a.id as string, { cache: 'reload' });
      await medplum.updateResource(markAllergyEnteredInError(fresh));
      notifications.show({ message: 'Marked entered-in-error', color: 'green' });
      load();
    } catch (err) {
      notifications.show({ message: String(err), color: 'red' });
    }
  }

  const visible = list?.filter((a) => showRetracted || allergyVerification(a) !== 'entered-in-error');

  return (
    <Stack gap="sm">
      <NewAllergyForm patientId={patientId} fixedCategory={category} onCreated={load} />
      <Group justify="space-between">
        <Text fw={600}>{category === 'food' ? 'Food allergies & intolerances' : 'Allergies & intolerances'}</Text>
        <Switch size="xs" label="Show entered-in-error" checked={showRetracted} onChange={(e) => setShowRetracted(e.currentTarget.checked)} />
      </Group>
      {visible === undefined ? (
        <Loader size="sm" />
      ) : visible.length === 0 ? (
        <Text c="dimmed" size="sm">
          {category === 'food' ? 'No food allergies recorded.' : 'No known allergies recorded (NKA not yet asserted — absence of data, not a negative finding).'}
        </Text>
      ) : (
        visible.map((a) => {
          const retracted = allergyVerification(a) === 'entered-in-error';
          return (
            <Paper key={a.id} withBorder p="sm" style={retracted ? { opacity: 0.55 } : undefined}>
              <Group justify="space-between" wrap="nowrap">
                <div>
                  <Group gap="xs">
                    <Text fw={600} td={retracted ? 'line-through' : undefined}>
                      {a.code?.text ?? '(unnamed substance)'}
                    </Text>
                    <Badge size="xs" variant="outline">{a.type ?? 'allergy'}</Badge>
                    {a.category?.map((c) => (
                      <Badge key={c} size="xs" variant="light" color="blue">{c}</Badge>
                    ))}
                    {a.criticality && <Badge size="xs" color={CRIT_COLOR[a.criticality]}>criticality: {a.criticality}</Badge>}
                    <Badge size="xs" variant="dot" color={retracted ? 'gray' : allergyVerification(a) === 'confirmed' ? 'green' : 'yellow'}>
                      {allergyVerification(a)}
                    </Badge>
                    {!retracted && <Badge size="xs" variant="transparent" color="gray">{allergyClinical(a)}</Badge>}
                  </Group>
                  {a.reaction?.map((r, i) => (
                    <Text key={i} size="sm" c="dimmed">
                      Reaction: {r.manifestation?.map((m) => m.text).join(', ')}
                      {r.severity ? ` (${r.severity})` : ''}
                    </Text>
                  ))}
                  {a.note?.map((n, i) => <Text key={i} size="xs" c="dimmed">{n.text}</Text>)}
                  <Text size="xs" c="dimmed">
                    Recorded {a.recordedDate?.slice(0, 10) ?? '—'}
                    {a.recorder?.display ? ` by ${a.recorder.display}` : ''}
                  </Text>
                </div>
                {!retracted && (
                  <Button size="xs" variant="subtle" color="red" onClick={() => retract(a)}>
                    Entered in error
                  </Button>
                )}
              </Group>
            </Paper>
          );
        })
      )}
    </Stack>
  );
}

function NewAllergyForm({ patientId, fixedCategory, onCreated }: { patientId: string; fixedCategory?: AllergyCategory; onCreated: () => void }) {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const [substance, setSubstance] = useState('');
  const [type, setType] = useState<'allergy' | 'intolerance'>('allergy');
  const [category, setCategory] = useState<AllergyCategory>(fixedCategory ?? 'medication');
  const [criticality, setCriticality] = useState<'low' | 'high' | 'unable-to-assess'>('unable-to-assess');
  const [verification, setVerification] = useState<'unconfirmed' | 'confirmed'>('unconfirmed');
  const [reaction, setReaction] = useState('');
  const [severity, setSeverity] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      await medplum.createResource(
        buildAllergy({
          patientId,
          substance,
          type,
          category: fixedCategory ?? category,
          criticality,
          verification,
          reaction,
          severity: (severity ?? undefined) as 'mild' | 'moderate' | 'severe' | undefined,
          recorder: profile ? { reference: `${profile.resourceType}/${profile.id}`, display: formatHumanName(profile.name) } : undefined,
        }),
      );
      setSubstance('');
      setReaction('');
      setSeverity(null);
      notifications.show({ message: 'Allergy recorded', color: 'green' });
      onCreated();
    } catch (err) {
      notifications.show({ message: String(err), color: 'red' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Paper withBorder p="sm">
      <SimpleGrid cols={{ base: 1, sm: 3 }}>
        <TextInput label="Substance" placeholder={fixedCategory === 'food' ? 'e.g. Peanuts, Lactose' : 'e.g. Penicillin'} value={substance} onChange={(e) => setSubstance(e.currentTarget.value)} required />
        <div>
          <Text size="sm" fw={500} mb={4}>Type</Text>
          <SegmentedControl size="xs" data={['allergy', 'intolerance']} value={type} onChange={(v) => setType(v as 'allergy' | 'intolerance')} />
        </div>
        {!fixedCategory && (
          <Select label="Category" data={['medication', 'food', 'environment', 'biologic']} value={category} onChange={(v) => setCategory((v ?? 'medication') as AllergyCategory)} />
        )}
        <Select
          label="Criticality"
          data={[{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }, { value: 'unable-to-assess', label: 'Unable to assess' }]}
          value={criticality}
          onChange={(v) => setCriticality((v ?? 'unable-to-assess') as typeof criticality)}
        />
        <Select
          label="Verification"
          data={[{ value: 'unconfirmed', label: 'Unconfirmed (reported)' }, { value: 'confirmed', label: 'Confirmed' }]}
          value={verification}
          onChange={(v) => setVerification((v ?? 'unconfirmed') as typeof verification)}
        />
        <DictationTextInput label="Reaction" placeholder="e.g. Hives, wheeze" value={reaction} onValueChange={setReaction} patientId={patientId} />
        <Select label="Reaction severity" data={['mild', 'moderate', 'severe']} value={severity} onChange={setSeverity} clearable disabled={!reaction.trim()} />
      </SimpleGrid>
      <Group justify="flex-end" mt="sm">
        <Button size="sm" loading={saving} disabled={!substance.trim()} onClick={handleSave}>
          Add {fixedCategory === 'food' ? 'food allergy / intolerance' : 'allergy'}
        </Button>
      </Group>
    </Paper>
  );
}
