import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Divider, Group, Loader, Menu, MultiSelect, Paper, Select, Stack, Table, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { NutritionOrder, Observation } from '@medplum/fhirtypes';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import { formatHumanName } from '../lib/fhirFormat.js';
import {
  DIET_TYPES,
  LIFESTYLE_ITEMS,
  NUTRITION_ORDER_TRANSITIONS,
  buildLifestyleObservation,
  buildNutritionOrder,
  obsText,
  type LifestyleItem,
} from '../lib/patientProfile.js';
import { PatientAllergies } from './PatientAllergies.js';
import { DictationTextInput } from './DictationTextarea.js';

/**
 * Social history & diet — smoking (LOINC 72166-2 + SNOMED answers confirmed
 * from HL7 US Core), alcohol, diet preference, meal pattern, physical
 * activity (local codes — see lib/patientProfile.ts header), food allergies
 * (PatientAllergies filtered to category=food), and dietitian diet orders
 * (NutritionOrder) with status transitions.
 *
 * Every social-history entry is a new point-in-time Observation; the table
 * shows the latest per item, with history underneath. Wrong entries are
 * marked entered-in-error, never deleted.
 *
 * Known gap, stated plainly: any signed-in clinician can place a diet order
 * from this tab. Restricting NutritionOrder writes to the dietitian/physician
 * roles is a server-side AccessPolicy concern (lib/hospital.ts roles) that is
 * not enforced by this component. Kitchen/meal-service fulfilment of the
 * order is not built.
 */
export function PatientLifestyle({ patientId }: { patientId: string }) {
  return (
    <Stack>
      <SocialHistory patientId={patientId} />
      <Divider />
      <Title order={5}>Food allergies &amp; intolerances</Title>
      <PatientAllergies patientId={patientId} category="food" />
      <Divider />
      <DietOrders patientId={patientId} />
    </Stack>
  );
}

const itemFor = (o: Observation): LifestyleItem | undefined =>
  LIFESTYLE_ITEMS.find((i) => o.code?.coding?.some((c) => c.system === i.code.system && c.code === i.code.code));

function SocialHistory({ patientId }: { patientId: string }) {
  const medplum = useMedplum();
  const [obs, setObs] = useState<Observation[] | undefined>();

  const load = useCallback(() => {
    medplum
      .searchResources('Observation', { subject: `Patient/${patientId}`, category: 'social-history', _sort: '-date', _count: 200 }, { cache: 'reload' })
      .then(setObs)
      .catch((err) => notifications.show({ message: String(err), color: 'red' }));
  }, [medplum, patientId]);
  useEffect(load, [load]);

  async function retract(o: Observation) {
    if (!window.confirm('Mark this entry as entered in error?')) return;
    try {
      const fresh = await medplum.readResource('Observation', o.id as string, { cache: 'reload' });
      await medplum.updateResource({ ...fresh, status: 'entered-in-error' });
      load();
    } catch (err) {
      notifications.show({ message: String(err), color: 'red' });
    }
  }

  return (
    <Stack gap="xs">
      <Title order={5}>Social history &amp; diet</Title>
      {obs === undefined ? (
        <Loader size="sm" />
      ) : (
        <Table withTableBorder verticalSpacing="xs">
          <Table.Thead>
            <Table.Tr>
              <Table.Th w={170}>Item</Table.Th>
              <Table.Th>Current</Table.Th>
              <Table.Th w={430}>Record new</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {LIFESTYLE_ITEMS.map((item) => {
              const history = obs.filter((o) => itemFor(o) === item && o.status !== 'entered-in-error');
              const latest = history[0];
              return (
                <Table.Tr key={item.key}>
                  <Table.Td>
                    <Text size="sm" fw={500}>{item.label}</Text>
                    <Text size="xs" c="dimmed">
                      {item.code.system === 'http://loinc.org' ? `LOINC ${item.code.code}` : 'local code'}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    {latest ? (
                      <Stack gap={2}>
                        <Group gap="xs">
                          <Text size="sm">{obsText(latest)}</Text>
                          <Button size="compact-xs" variant="subtle" color="red" onClick={() => retract(latest)}>
                            entered in error
                          </Button>
                        </Group>
                        {latest.note?.[0]?.text && <Text size="xs" c="dimmed">{latest.note[0].text}</Text>}
                        <Text size="xs" c="dimmed">
                          {latest.effectiveDateTime?.slice(0, 10)}
                          {latest.performer?.[0]?.display ? ` · ${latest.performer[0].display}` : ''}
                          {history.length > 1 ? ` · earlier: ${history.slice(1, 4).map(obsText).join(', ')}` : ''}
                        </Text>
                      </Stack>
                    ) : (
                      <Text size="sm" c="dimmed">Not recorded</Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <RecordLifestyle patientId={patientId} item={item} onSaved={load} />
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}

function RecordLifestyle({ patientId, item, onSaved }: { patientId: string; item: LifestyleItem; onSaved: () => void }) {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const [answer, setAnswer] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const ok = !!answer || !!note.trim();

  async function save() {
    setSaving(true);
    try {
      const performer = profile ? { reference: `${profile.resourceType}/${profile.id}`, display: formatHumanName(profile.name) } : undefined;
      await medplum.createResource(buildLifestyleObservation(patientId, item, answer ?? undefined, note, performer));
      setAnswer(null);
      setNote('');
      onSaved();
    } catch (err) {
      notifications.show({ message: String(err), color: 'red' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Group gap="xs" wrap="nowrap">
      {item.answers && (
        <Select size="xs" w={170} placeholder="Choose…" data={item.answers.map((a) => ({ value: a.code, label: a.display }))} value={answer} onChange={setAnswer} clearable />
      )}
      <DictationTextInput
        size="xs"
        style={{ flex: 1 }}
        placeholder={item.freeText ? 'e.g. 3 meals + 2 snacks, late dinner' : 'Detail / note (optional)'}
        value={note}
        onValueChange={setNote}
        patientId={patientId}
      />
      <Button size="xs" disabled={!ok} loading={saving} onClick={save}>
        Save
      </Button>
    </Group>
  );
}

const STATUS_COLOR: Record<string, string> = { active: 'green', 'on-hold': 'yellow', completed: 'gray', revoked: 'red', 'entered-in-error': 'gray', draft: 'blue' };

function DietOrders({ patientId }: { patientId: string }) {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const [orders, setOrders] = useState<NutritionOrder[] | undefined>();
  const [diets, setDiets] = useState<string[]>([]);
  const [instruction, setInstruction] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    medplum
      .searchResources('NutritionOrder', { patient: `Patient/${patientId}`, _sort: '-_lastUpdated', _count: 50 }, { cache: 'reload' })
      .then(setOrders)
      .catch((err) => notifications.show({ message: String(err), color: 'red' }));
  }, [medplum, patientId]);
  useEffect(load, [load]);

  async function place() {
    setSaving(true);
    try {
      // Carry the latest diet preference and active food allergies onto the order.
      const [pref] = await medplum.searchResources(
        'Observation',
        { subject: `Patient/${patientId}`, code: 'https://hins.example/fhir/CodeSystem/social-history|diet-preference', 'status:not': 'entered-in-error', _sort: '-date', _count: 1 },
        { cache: 'reload' },
      );
      const food = await medplum.searchResources(
        'AllergyIntolerance',
        { patient: `Patient/${patientId}`, category: 'food', 'verification-status:not': 'entered-in-error' },
        { cache: 'reload' },
      );
      await medplum.createResource(
        buildNutritionOrder({
          patientId,
          dietCodes: diets,
          instruction,
          foodPreference: obsText(pref) || undefined,
          allergyIds: food.map((a) => a.id as string),
          orderer: profile ? { reference: `${profile.resourceType}/${profile.id}`, display: formatHumanName(profile.name) } : undefined,
        }),
      );
      setDiets([]);
      setInstruction('');
      notifications.show({ message: 'Diet order placed', color: 'green' });
      load();
    } catch (err) {
      notifications.show({ message: String(err), color: 'red' });
    } finally {
      setSaving(false);
    }
  }

  async function transition(o: NutritionOrder, status: NutritionOrder['status']) {
    try {
      const fresh = await medplum.readResource('NutritionOrder', o.id as string, { cache: 'reload' });
      await medplum.updateResource({ ...fresh, status });
      load();
    } catch (err) {
      notifications.show({ message: String(err), color: 'red' });
    }
  }

  return (
    <Stack gap="xs">
      <Title order={5}>Diet orders</Title>
      <Paper withBorder p="sm">
        <Group align="flex-end" wrap="wrap">
          <MultiSelect
            label="Diet"
            placeholder="e.g. Diabetic + Low salt"
            data={DIET_TYPES.map((d) => ({ value: d.code, label: d.display }))}
            value={diets}
            onChange={setDiets}
            w={320}
            searchable
          />
          <DictationTextInput label="Instructions" placeholder="e.g. 1800 kcal/day, small frequent meals" style={{ flex: 1, minWidth: 220 }} value={instruction} onValueChange={setInstruction} patientId={patientId} />
          <Button disabled={!diets.length} loading={saving} onClick={place}>
            Place diet order
          </Button>
        </Group>
        <Text size="xs" c="dimmed" mt={4}>
          The patient's latest diet preference and recorded food allergies are attached to the order automatically.
        </Text>
      </Paper>
      {orders === undefined ? (
        <Loader size="sm" />
      ) : orders.length === 0 ? (
        <Text size="sm" c="dimmed">No diet orders.</Text>
      ) : (
        orders.map((o) => (
          <Paper key={o.id} withBorder p="sm" style={o.status === 'entered-in-error' ? { opacity: 0.55 } : undefined}>
            <Group justify="space-between" wrap="nowrap">
              <div>
                <Group gap="xs">
                  <Text fw={600}>{o.oralDiet?.type?.map((t) => t.text).join(' + ') ?? 'Diet order'}</Text>
                  <Badge size="sm" color={STATUS_COLOR[o.status] ?? 'gray'}>{o.status}</Badge>
                </Group>
                {o.oralDiet?.instruction && <Text size="sm">{o.oralDiet.instruction}</Text>}
                <Text size="xs" c="dimmed">
                  {o.dateTime?.slice(0, 16).replace('T', ' ')}
                  {o.orderer?.display ? ` · ordered by ${o.orderer.display}` : ''}
                  {o.foodPreferenceModifier?.length ? ` · preference: ${o.foodPreferenceModifier.map((f) => f.text).join(', ')}` : ''}
                  {o.allergyIntolerance?.length ? ` · ${o.allergyIntolerance.length} food allergy/intolerance linked` : ''}
                </Text>
              </div>
              {NUTRITION_ORDER_TRANSITIONS[o.status] && (
                <Menu position="bottom-end">
                  <Menu.Target>
                    <Button size="xs" variant="light">Change status</Button>
                  </Menu.Target>
                  <Menu.Dropdown>
                    {NUTRITION_ORDER_TRANSITIONS[o.status].map((s) => (
                      <Menu.Item key={s} color={s === 'entered-in-error' || s === 'revoked' ? 'red' : undefined} onClick={() => transition(o, s)}>
                        {s}
                      </Menu.Item>
                    ))}
                  </Menu.Dropdown>
                </Menu>
              )}
            </Group>
          </Paper>
        ))
      )}
    </Stack>
  );
}
