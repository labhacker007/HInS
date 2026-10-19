import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Group, Loader, NumberInput, Paper, ScrollArea, SimpleGrid, Stack, Switch, Table, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { Observation } from '@medplum/fhirtypes';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import { formatHumanName } from '../lib/fhirFormat.js';
import {
  VITAL_DEFS,
  buildVitalsObservations,
  computeBmi,
  formatVital,
  validateVitals,
  vitalKey,
  type VitalsInput,
} from '../lib/patientProfile.js';

/**
 * Vital signs — entry + trend table. One Observation per vital, conforming
 * to the FHIR R4 vital-signs profile (meta.profile set; this Medplum
 * validated every shape on write during live verification), LOINC codes and
 * UCUM units from lib/patientProfile.ts. A reading = all Observations sharing
 * one effectiveDateTime; BMI (39156-5) is computed client-side from weight +
 * this reading's height, else the latest height on file.
 *
 * Wrong readings are marked entered-in-error (all Observations of that
 * reading), never deleted.
 *
 * Known gap, stated plainly: readings are not linked to an Encounter from
 * this tab (no "current encounter" context exists in PatientDetail yet), no
 * early-warning score (NEWS2) is computed, and plausibility ranges are coarse
 * typo guards, not clinical alert thresholds.
 */
type Reading = { at: string; obs: Observation[]; by?: string };

export function PatientVitals({ patientId }: { patientId: string }) {
  const medplum = useMedplum();
  const [obs, setObs] = useState<Observation[] | undefined>();
  const [showRetracted, setShowRetracted] = useState(false);

  const load = useCallback(() => {
    medplum
      .searchResources('Observation', { subject: `Patient/${patientId}`, category: 'vital-signs', _sort: '-date', _count: 400 }, { cache: 'reload' })
      .then(setObs)
      .catch((err) => notifications.show({ message: String(err), color: 'red' }));
  }, [medplum, patientId]);
  useEffect(load, [load]);

  const readings = useMemo(() => {
    const map = new Map<string, Reading>();
    for (const o of obs ?? []) {
      if (!showRetracted && o.status === 'entered-in-error') continue;
      const at = o.effectiveDateTime ?? o.meta?.lastUpdated ?? '';
      const r = map.get(at) ?? { at, obs: [], by: o.performer?.[0]?.display };
      r.obs.push(o);
      map.set(at, r);
    }
    return [...map.values()].sort((a, b) => b.at.localeCompare(a.at));
  }, [obs, showRetracted]);

  const latestHeight = obs?.find((o) => vitalKey(o) === 'heightCm' && o.status !== 'entered-in-error')?.valueQuantity?.value;

  async function retract(r: Reading) {
    if (!window.confirm(`Mark the ${r.at.slice(0, 16).replace('T', ' ')} reading as entered in error?`)) return;
    try {
      for (const o of r.obs) {
        const fresh = await medplum.readResource('Observation', o.id as string, { cache: 'reload' });
        await medplum.updateResource({ ...fresh, status: 'entered-in-error' });
      }
      load();
    } catch (err) {
      notifications.show({ message: String(err), color: 'red' });
    }
  }

  return (
    <Stack>
      <VitalsEntry patientId={patientId} fallbackHeightCm={latestHeight} onSaved={load} />
      <Group justify="space-between">
        <Title order={5}>Trend</Title>
        <Switch size="xs" label="Show entered-in-error" checked={showRetracted} onChange={(e) => setShowRetracted(e.currentTarget.checked)} />
      </Group>
      {obs === undefined ? (
        <Loader size="sm" />
      ) : readings.length === 0 ? (
        <Text c="dimmed" size="sm">No vitals recorded.</Text>
      ) : (
        <ScrollArea>
          <Table striped withTableBorder verticalSpacing={4} miw={900}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Taken</Table.Th>
                {VITAL_DEFS.map((d) => (
                  <Table.Th key={d.key}>
                    {d.label}
                    <Text size="xs" c="dimmed" fw={400}>{d.unit} · LOINC {d.coding[0].code}</Text>
                  </Table.Th>
                ))}
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {readings.map((r) => {
                const retracted = r.obs.every((o) => o.status === 'entered-in-error');
                return (
                  <Table.Tr key={r.at} style={retracted ? { opacity: 0.5, textDecoration: 'line-through' } : undefined}>
                    <Table.Td>
                      <Text size="sm">{r.at.slice(0, 16).replace('T', ' ')}</Text>
                      {r.by && <Text size="xs" c="dimmed">{r.by}</Text>}
                    </Table.Td>
                    {VITAL_DEFS.map((d) => {
                      const o = r.obs.find((x) => vitalKey(x) === d.key);
                      return <Table.Td key={d.key}>{o ? formatVital(o) : ''}</Table.Td>;
                    })}
                    <Table.Td>
                      {!retracted && (
                        <Button size="compact-xs" variant="subtle" color="red" onClick={() => retract(r)}>
                          entered in error
                        </Button>
                      )}
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </ScrollArea>
      )}
    </Stack>
  );
}

const num = (v: string | number): number | undefined => (v === '' || v === undefined || Number.isNaN(Number(v)) ? undefined : Number(v));

function VitalsEntry({ patientId, fallbackHeightCm, onSaved }: { patientId: string; fallbackHeightCm?: number; onSaved: () => void }) {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const [v, setV] = useState<VitalsInput>({});
  const [saving, setSaving] = useState(false);
  const set = (k: keyof VitalsInput) => (val: string | number) => setV((p) => ({ ...p, [k]: num(val) }));
  const errors = validateVitals(v);
  const touched = Object.values(v).some((x) => x !== undefined);
  const h = v.heightCm ?? fallbackHeightCm;
  const bmi = v.weightKg !== undefined && h ? computeBmi(v.weightKg, h) : undefined;

  async function save() {
    setSaving(true);
    const created: Observation[] = [];
    try {
      const performer = profile ? { reference: `${profile.resourceType}/${profile.id}`, display: formatHumanName(profile.name) } : undefined;
      // Sequential creates (transaction Bundles are not atomic on this server
      // anyway); if one fails, the ones already written are retracted.
      for (const o of buildVitalsObservations(patientId, v, { performer, fallbackHeightCm })) {
        created.push(await medplum.createResource(o));
      }
      setV({});
      notifications.show({ message: `Saved ${created.length} vital sign observation(s)`, color: 'green' });
      onSaved();
    } catch (err) {
      for (const o of created) await medplum.updateResource({ ...o, status: 'entered-in-error' }).catch(() => undefined);
      notifications.show({ message: `Not saved: ${String(err)}`, color: 'red' });
    } finally {
      setSaving(false);
    }
  }

  const n = (k: keyof VitalsInput, label: string, unit: string, step = 1) => (
    <NumberInput label={label} rightSection={<Text size="xs" c="dimmed">{unit}</Text>} rightSectionWidth={48} value={v[k] ?? ''} onChange={set(k)} step={step} decimalScale={step < 1 ? 1 : 0} hideControls />
  );

  return (
    <Paper withBorder p="sm">
      <Title order={5} mb="xs">Record vitals</Title>
      <SimpleGrid cols={{ base: 2, sm: 5 }}>
        {n('systolic', 'Systolic', 'mmHg')}
        {n('diastolic', 'Diastolic', 'mmHg')}
        {n('heartRate', 'Heart rate', '/min')}
        {n('respRate', 'Resp. rate', '/min')}
        {n('tempC', 'Temperature', '°C', 0.1)}
        {n('spo2', 'SpO₂', '%')}
        {n('weightKg', 'Weight', 'kg', 0.1)}
        {n('heightCm', 'Height', 'cm', 0.1)}
        <NumberInput
          label="BMI (computed)"
          value={bmi ?? ''}
          readOnly
          variant="filled"
          description={v.weightKg !== undefined && !v.heightCm && fallbackHeightCm ? `using last height ${fallbackHeightCm} cm` : undefined}
          rightSection={<Text size="xs" c="dimmed">kg/m²</Text>}
          rightSectionWidth={48}
        />
      </SimpleGrid>
      {touched && errors.length > 0 && (
        <Alert color="orange" variant="light" mt="sm" p="xs">
          {errors.map((e) => <Text key={e} size="sm">{e}</Text>)}
        </Alert>
      )}
      <Group justify="flex-end" mt="sm">
        <Button disabled={errors.length > 0} loading={saving} onClick={save}>
          Save vitals
        </Button>
      </Group>
    </Paper>
  );
}
