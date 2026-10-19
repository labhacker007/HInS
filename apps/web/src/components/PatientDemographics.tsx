import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Autocomplete,
  Badge,
  Button,
  Divider,
  Group,
  Loader,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { Observation, Patient } from '@medplum/fhirtypes';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import { formatHumanName } from '../lib/fhirFormat.js';
import {
  BLOOD_GROUPS,
  BLOOD_GROUP_CODE,
  INDIAN_STATES,
  LANGUAGE_OPTIONS,
  MARITAL_OPTIONS,
  OCCUPATION_CODE,
  RELATIONSHIPS,
  latestObservation,
  normalizeAbhaNumber,
  obsText,
  patientToForm,
  saveDemographics,
  validateDemographics,
  type DemographicsErrors,
  type DemographicsForm,
} from '../lib/patientProfile.js';

/**
 * Demographics — editable panel in PatientDetail and the field set reused by
 * NewPatient.tsx registration. All FHIR shapes, identifier systems and
 * validation live in lib/patientProfile.ts (see its header for where every
 * code/system came from, incl. the ABHA-address placeholder system).
 *
 * Edits are a normal Patient update, so every prior version stays in the
 * resource's _history. Blood group and occupation are Observations, not
 * Patient fields; a new one is recorded only when the value changes.
 *
 * Known gap, stated plainly: ABHA numbers/addresses are format-checked only.
 * Creating or verifying an ABHA needs the ABDM M1 (ABHA) APIs, which require
 * ABDM sandbox client credentials the hospital has to register for — until
 * then the "Verify with ABDM" button is disabled and says so. Nothing here
 * marks an ABHA as verified.
 */

export function DemographicsFields({
  value,
  onChange,
  errors,
}: {
  value: DemographicsForm;
  onChange: (next: DemographicsForm) => void;
  errors: DemographicsErrors;
}) {
  const set = (k: keyof DemographicsForm) => (v: string | null) => onChange({ ...value, [k]: v ?? '' });
  const input = (k: keyof DemographicsForm) => ({
    value: value[k],
    error: errors[k],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange({ ...value, [k]: e.currentTarget.value }),
  });

  return (
    <Stack gap="sm">
      <Title order={5}>Name &amp; identity</Title>
      <SimpleGrid cols={{ base: 1, sm: 4 }}>
        <TextInput label="Prefix" placeholder="Mr. / Ms. / Dr." {...input('prefix')} />
        <TextInput label="First name" required {...input('givenFirst')} />
        <TextInput label="Middle name(s)" {...input('givenMiddle')} />
        <TextInput label="Family name" required {...input('family')} />
      </SimpleGrid>
      <SimpleGrid cols={{ base: 1, sm: 4 }}>
        <Select label="Gender" data={['male', 'female', 'other', 'unknown']} value={value.gender || null} onChange={set('gender')} clearable />
        <TextInput label="Date of birth" type="date" required {...input('birthDate')} />
        <Select label="Marital status" data={MARITAL_OPTIONS} value={value.maritalStatus || null} onChange={set('maritalStatus')} clearable />
        <Select label="Preferred language" data={LANGUAGE_OPTIONS} value={value.language || null} onChange={set('language')} clearable searchable />
      </SimpleGrid>
      <SimpleGrid cols={{ base: 1, sm: 4 }}>
        <TextInput label="Occupation" {...input('occupation')} />
        <Select
          label="Blood group (ABO/Rh)"
          description="Recorded as LOINC 882-1, free-text value"
          data={BLOOD_GROUPS}
          value={value.bloodGroup || null}
          onChange={set('bloodGroup')}
          clearable
        />
      </SimpleGrid>

      <Title order={5} mt="xs">Contact</Title>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <TextInput label="Mobile" placeholder="+91 98765 43210" {...input('phone')} />
        <TextInput label="Email" type="email" {...input('email')} />
      </SimpleGrid>
      <TextInput label="Address" placeholder="House / street, locality (comma-separated lines)" {...input('addrLine')} />
      <SimpleGrid cols={{ base: 1, sm: 5 }}>
        <TextInput label="City / town" {...input('city')} />
        <TextInput label="District" {...input('district')} />
        <Autocomplete label="State / UT" data={INDIAN_STATES} value={value.state} onChange={set('state')} error={errors.state} />
        <TextInput label="PIN code" maxLength={6} {...input('pin')} />
        <TextInput label="Country (ISO)" maxLength={2} {...input('country')} />
      </SimpleGrid>

      <Title order={5} mt="xs">Emergency contact</Title>
      <SimpleGrid cols={{ base: 1, sm: 3 }}>
        <TextInput label="Name" {...input('ecName')} />
        <Autocomplete label="Relationship" data={RELATIONSHIPS} value={value.ecRelationship} onChange={set('ecRelationship')} />
        <TextInput label="Phone" {...input('ecPhone')} />
      </SimpleGrid>

      <Title order={5} mt="xs">ABHA (Ayushman Bharat Health Account)</Title>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <TextInput
          label="ABHA number"
          placeholder="XX-XXXX-XXXX-XXXX"
          description="14 digits; stored as XX-XXXX-XXXX-XXXX"
          {...input('abhaNumber')}
          onBlur={() => {
            const n = normalizeAbhaNumber(value.abhaNumber);
            if (n) onChange({ ...value, abhaNumber: n });
          }}
        />
        <TextInput label="ABHA address" placeholder="name@abdm (or name@sbx in sandbox)" description="@abdm or @sbx" {...input('abhaAddress')} />
      </SimpleGrid>
      <AbhaVerifyNotice />
    </Stack>
  );
}

function AbhaVerifyNotice() {
  return (
    <Group gap="sm" align="center">
      <Tooltip
        multiline
        w={320}
        label="Needs ABDM sandbox client credentials (client ID/secret) that the hospital must register for with NHA. Not configured — no verification is performed or implied."
      >
        <span>
          <Button size="xs" variant="default" disabled>
            Verify with ABDM
          </Button>
        </span>
      </Tooltip>
      <Text size="xs" c="dimmed">
        Unverified — format-checked only. ABDM M1 (ABHA) APIs not connected.
      </Text>
    </Group>
  );
}

function SummaryRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Group gap="xs" wrap="nowrap" align="flex-start">
      <Text size="sm" c="dimmed" w={150} style={{ flexShrink: 0 }}>
        {label}
      </Text>
      <Text size="sm">{value || '—'}</Text>
    </Group>
  );
}

export function PatientDemographics({ patient, onSaved }: { patient: Patient; onSaved: () => void }) {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const [bloodGroup, setBloodGroup] = useState<Observation | undefined | null>(null);
  const [occupation, setOccupation] = useState<Observation | undefined | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<DemographicsForm>(() => patientToForm(patient));
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    latestObservation(medplum, patient.id as string, BLOOD_GROUP_CODE).then(setBloodGroup).catch(() => setBloodGroup(undefined));
    latestObservation(medplum, patient.id as string, OCCUPATION_CODE).then(setOccupation).catch(() => setOccupation(undefined));
  }, [medplum, patient.id]);
  useEffect(load, [load]);

  const errors = validateDemographics(form);

  function startEdit() {
    setForm({ ...patientToForm(patient), bloodGroup: obsText(bloodGroup ?? undefined), occupation: obsText(occupation ?? undefined) });
    setEditing(true);
  }

  async function handleSave() {
    if (Object.keys(errors).length) return;
    setSaving(true);
    try {
      // Re-read fresh so we never overwrite a concurrent edit with a stale copy.
      const fresh = await medplum.readResource('Patient', patient.id as string, { cache: 'reload' });
      if (fresh.meta?.versionId !== patient.meta?.versionId) {
        notifications.show({ message: 'This record changed since you opened it — reloaded; please re-apply your edit.', color: 'orange' });
        setEditing(false);
        onSaved();
        return;
      }
      const performer =
        profile?.resourceType === 'Practitioner' ? { reference: `Practitioner/${profile.id}`, display: formatHumanName(profile.name) } : undefined;
      await saveDemographics(medplum, form, fresh, {}, performer);
      notifications.show({ message: 'Demographics saved', color: 'green' });
      setEditing(false);
      load();
      onSaved();
    } catch (err) {
      notifications.show({ message: String(err), color: 'red' });
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <Paper withBorder p="md">
        <DemographicsFields value={form} onChange={setForm} errors={errors} />
        <Group justify="flex-end" mt="md">
          <Button variant="subtle" onClick={() => setEditing(false)}>
            Cancel
          </Button>
          <Button loading={saving} disabled={Object.keys(errors).length > 0} onClick={handleSave}>
            Save demographics
          </Button>
        </Group>
      </Paper>
    );
  }

  const f = patientToForm(patient);
  const lang = LANGUAGE_OPTIONS.find((l) => l.value === f.language)?.label;
  const marital = MARITAL_OPTIONS.find((m) => m.value === f.maritalStatus)?.label ?? patient.maritalStatus?.text;
  const address = [f.addrLine, f.city, f.district, f.state, f.pin, f.country].filter(Boolean).join(', ');

  return (
    <Paper withBorder p="md" maw={760}>
      <Group justify="space-between" mb="sm">
        <Title order={5}>Demographics</Title>
        <Button size="xs" variant="light" onClick={startEdit}>
          Edit
        </Button>
      </Group>
      <Stack gap={4}>
        <SummaryRow label="Name" value={[f.prefix, f.givenFirst, f.givenMiddle, f.family].filter(Boolean).join(' ')} />
        <SummaryRow label="Gender / DOB" value={`${f.gender || '—'} · ${f.birthDate || '—'}`} />
        <SummaryRow label="Marital status" value={marital} />
        <SummaryRow label="Preferred language" value={lang} />
        <SummaryRow label="Occupation" value={occupation === null ? <Loader size="xs" /> : obsText(occupation)} />
        <SummaryRow label="Blood group" value={bloodGroup === null ? <Loader size="xs" /> : obsText(bloodGroup)} />
        <Divider my={6} />
        <SummaryRow label="Mobile" value={f.phone} />
        <SummaryRow label="Email" value={f.email} />
        <SummaryRow label="Address" value={address} />
        <SummaryRow label="Emergency contact" value={f.ecName && `${f.ecName}${f.ecRelationship ? ` (${f.ecRelationship})` : ''}${f.ecPhone ? ` · ${f.ecPhone}` : ''}`} />
        <Divider my={6} />
        <SummaryRow
          label="ABHA number"
          value={f.abhaNumber && (
            <>
              {f.abhaNumber}{' '}
              <Badge size="xs" color="gray" variant="outline">
                unverified
              </Badge>
            </>
          )}
        />
        <SummaryRow label="ABHA address" value={f.abhaAddress} />
      </Stack>
      <Alert mt="sm" variant="light" color="gray" p="xs">
        <AbhaVerifyNotice />
      </Alert>
    </Paper>
  );
}
