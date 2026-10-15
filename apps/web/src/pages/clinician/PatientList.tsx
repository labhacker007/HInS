import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Stack, Group, Title, Button, TextInput, Table, Text, Loader } from '@mantine/core';
import type { Patient } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { formatHumanName, formatPatientMrn } from '../../lib/fhirFormat.js';

export function PatientList() {
  const medplum = useMedplum();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [patients, setPatients] = useState<Patient[] | undefined>();

  useEffect(() => {
    let cancelled = false;
    setPatients(undefined);
    medplum
      .searchResources('Patient', query ? { name: query, _sort: '-_lastUpdated', _count: 50 } : { _sort: '-_lastUpdated', _count: 50 })
      .then((result) => {
        if (!cancelled) setPatients(result);
      });
    return () => {
      cancelled = true;
    };
  }, [medplum, query]);

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={3}>Patients</Title>
        <Button onClick={() => navigate('/patients/new')}>Register new patient</Button>
      </Group>
      <TextInput
        placeholder="Search by name…"
        value={query}
        onChange={(e) => setQuery(e.currentTarget.value)}
        w={320}
      />
      {patients === undefined ? (
        <Loader size="sm" />
      ) : patients.length === 0 ? (
        <Text c="dimmed">No patients yet. Register the first one.</Text>
      ) : (
        <Table highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Name</Table.Th>
              <Table.Th>MRN</Table.Th>
              <Table.Th>DOB</Table.Th>
              <Table.Th>Gender</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {patients.map((p) => (
              <Table.Tr key={p.id} onClick={() => navigate(`/patients/${p.id}`)} style={{ cursor: 'pointer' }}>
                <Table.Td>{formatHumanName(p.name)}</Table.Td>
                <Table.Td>{formatPatientMrn(p)}</Table.Td>
                <Table.Td>{p.birthDate ?? '—'}</Table.Td>
                <Table.Td>{p.gender ?? '—'}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}
