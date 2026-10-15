import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Stack, Title, TextInput, Select, Button, Group } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMedplum } from '@medplum/react';
import { MRN_SYSTEM } from '../../lib/fhirFormat.js';

/** Registration — Phase 01 (blueprint §13), the first step of the OPD workflow. */
export function NewPatient() {
  const medplum = useMedplum();
  const navigate = useNavigate();
  const [given, setGiven] = useState('');
  const [family, setFamily] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [gender, setGender] = useState<string | null>(null);
  const [phone, setPhone] = useState('');
  const [saving, setSaving] = useState(false);

  const canSave = given.trim() && family.trim() && birthDate;

  async function handleSave() {
    setSaving(true);
    try {
      const patient = await medplum.createResource({
        resourceType: 'Patient',
        name: [{ given: [given.trim()], family: family.trim() }],
        birthDate,
        gender: (gender as 'male' | 'female' | 'other' | 'unknown' | undefined) ?? undefined,
        telecom: phone ? [{ system: 'phone', value: phone }] : undefined,
        identifier: [{ system: MRN_SYSTEM, value: crypto.randomUUID().slice(0, 8).toUpperCase() }],
      });
      notifications.show({ message: 'Patient registered', color: 'green' });
      navigate(`/patients/${patient.id}`);
    } catch (err) {
      notifications.show({ message: String(err), color: 'red' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Stack maw={480}>
      <Title order={3}>Register new patient</Title>
      <TextInput label="Given name" required value={given} onChange={(e) => setGiven(e.currentTarget.value)} />
      <TextInput label="Family name" required value={family} onChange={(e) => setFamily(e.currentTarget.value)} />
      <TextInput
        label="Date of birth"
        type="date"
        required
        value={birthDate}
        onChange={(e) => setBirthDate(e.currentTarget.value)}
      />
      <Select
        label="Gender"
        data={['male', 'female', 'other', 'unknown']}
        value={gender}
        onChange={setGender}
      />
      <TextInput label="Phone" value={phone} onChange={(e) => setPhone(e.currentTarget.value)} />
      <Group justify="flex-end" mt="md">
        <Button variant="subtle" onClick={() => navigate(-1)}>
          Cancel
        </Button>
        <Button disabled={!canSave} loading={saving} onClick={handleSave}>
          Register
        </Button>
      </Group>
    </Stack>
  );
}
