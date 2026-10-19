import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Stack, Title, Button, Group, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import { MRN_SYSTEM, formatHumanName } from '../../lib/fhirFormat.js';
import { DemographicsFields } from '../../components/PatientDemographics.js';
import { EMPTY_DEMOGRAPHICS, saveDemographics, validateDemographics, type DemographicsForm } from '../../lib/patientProfile.js';

/**
 * Registration — Phase 01 (blueprint §13), the first step of the OPD workflow.
 * Captures full demographics (see components/PatientDemographics.tsx and
 * lib/patientProfile.ts); only first/family name and DOB are mandatory so a
 * busy front desk can register fast and complete the rest later from the
 * patient's Demographics tab.
 */
export function NewPatient() {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const navigate = useNavigate();
  const [form, setForm] = useState<DemographicsForm>({ ...EMPTY_DEMOGRAPHICS });
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);

  const errors = validateDemographics(form);
  const hasErrors = Object.keys(errors).length > 0;

  async function handleSave() {
    if (hasErrors) {
      setShowErrors(true);
      return;
    }
    setSaving(true);
    try {
      const performer =
        profile?.resourceType === 'Practitioner' ? { reference: `Practitioner/${profile.id}`, display: formatHumanName(profile.name) } : undefined;
      const patient = await saveDemographics(
        medplum,
        form,
        undefined,
        { identifier: [{ system: MRN_SYSTEM, value: crypto.randomUUID().slice(0, 8).toUpperCase() }] },
        performer,
      );
      notifications.show({ message: 'Patient registered', color: 'green' });
      navigate(`/patients/${patient.id}`);
    } catch (err) {
      notifications.show({ message: String(err), color: 'red' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Stack maw={960}>
      <Title order={3}>Register new patient</Title>
      <Text size="sm" c="dimmed">
        Required: first name, family name, date of birth. Everything else can be completed later.
      </Text>
      <DemographicsFields
        value={form}
        onChange={setForm}
        // Required-field errors only after a save attempt; format errors as soon as a field has content.
        errors={showErrors ? errors : Object.fromEntries(Object.entries(errors).filter(([k]) => form[k as keyof DemographicsForm]))}
      />
      <Group justify="flex-end" mt="md">
        <Button variant="subtle" onClick={() => navigate(-1)}>
          Cancel
        </Button>
        <Button loading={saving} onClick={handleSave}>
          Register
        </Button>
      </Group>
    </Stack>
  );
}
