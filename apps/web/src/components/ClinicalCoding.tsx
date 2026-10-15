import { Paper, Group, Text, Badge, Stack, Loader } from '@mantine/core';
import type { Condition, Observation } from '@medplum/fhirtypes';

/**
 * Read-only display of coded clinical data (blueprint §03.6 — "coded, not
 * free-text, wherever a terminology exists"). Shared between the clinician
 * app and the patient portal so both see the same codes, not two
 * re-implementations that could drift.
 */

function codingBadge(system: string | undefined, label: string, code: string | undefined) {
  if (!code) return null;
  return (
    <Badge key={system} size="sm" variant="outline" title={system}>
      {label} {code}
    </Badge>
  );
}

export function DiagnosesList({ conditions }: { conditions: Condition[] | undefined }) {
  if (conditions === undefined) return <Loader size="sm" />;
  if (conditions.length === 0) return <Text c="dimmed">No diagnoses recorded.</Text>;
  return (
    <Stack gap="sm">
      {conditions.map((c) => {
        const snomed = c.code?.coding?.find((x) => x.system === 'http://snomed.info/sct');
        const icd10 = c.code?.coding?.find((x) => x.system === 'http://hl7.org/fhir/sid/icd-10');
        return (
          <Paper key={c.id} withBorder p="sm">
            <Group justify="space-between" mb={4}>
              <Text fw={600}>{c.code?.text ?? snomed?.display ?? 'Diagnosis'}</Text>
              <Badge size="sm" variant="light" color={c.verificationStatus?.coding?.[0]?.code === 'provisional' ? 'yellow' : 'green'}>
                {c.verificationStatus?.coding?.[0]?.code ?? 'confirmed'}
              </Badge>
            </Group>
            <Group gap="xs">
              {codingBadge('http://snomed.info/sct', 'SNOMED CT', snomed?.code)}
              {codingBadge('http://hl7.org/fhir/sid/icd-10', 'ICD-10', icd10?.code)}
            </Group>
          </Paper>
        );
      })}
    </Stack>
  );
}

export function LabResultsList({ observations }: { observations: Observation[] | undefined }) {
  if (observations === undefined) return <Loader size="sm" />;
  if (observations.length === 0) return <Text c="dimmed">No lab results yet.</Text>;
  return (
    <Stack gap="sm">
      {observations.map((o) => {
        const loinc = o.code?.coding?.find((x) => x.system === 'http://loinc.org');
        return (
          <Paper key={o.id} withBorder p="sm">
            <Group justify="space-between">
              <div>
                <Text fw={600}>{o.code?.text ?? loinc?.display ?? 'Lab result'}</Text>
                <Text size="xs" c="dimmed" title="LOINC">
                  LOINC {loinc?.code ?? '—'}
                </Text>
              </div>
              <Group gap={4} align="baseline">
                <Text fw={700} size="lg">
                  {o.valueQuantity?.value}
                </Text>
                <Text size="sm" c="dimmed">
                  {o.valueQuantity?.unit}
                </Text>
              </Group>
            </Group>
            <Text size="xs" c="dimmed" mt={4}>
              {o.effectiveDateTime?.slice(0, 10)}
            </Text>
          </Paper>
        );
      })}
    </Stack>
  );
}
