import { Routes, Route, Link, useNavigate } from 'react-router';
import { AppShell, Group, Title, Button, Text } from '@mantine/core';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import { PatientList } from './PatientList.js';
import { NewPatient } from './NewPatient.js';
import { PatientDetail } from './PatientDetail.js';
import { CatchAll } from '../../App.js';
import { NotificationBell } from '../../components/NotificationBell.js';

export function ClinicianApp() {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const navigate = useNavigate();

  return (
    <AppShell header={{ height: 60 }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group gap="xl">
            <Title order={4}>
              <Link to="/" style={{ textDecoration: 'none', color: 'inherit' }}>
                HInS — Clinician
              </Link>
            </Title>
            <Text size="sm" c="dimmed">
              {profile?.resourceType === 'Practitioner' &&
                `Dr. ${profile.name?.[0]?.given?.[0] ?? ''} ${profile.name?.[0]?.family ?? ''}`.trim()}
            </Text>
          </Group>
          <Group gap="sm">
            <NotificationBell practitionerId={profile?.id} />
            <Button
              variant="subtle"
              size="sm"
              onClick={() => {
                medplum.signOut().then(() => navigate('/'));
              }}
            >
              Sign out
            </Button>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Main>
        <Routes>
          <Route path="/" element={<PatientList />} />
          <Route path="/patients/new" element={<NewPatient />} />
          <Route path="/patients/:id" element={<PatientDetail />} />
          <Route path="*" element={<CatchAll to="/" />} />
        </Routes>
      </AppShell.Main>
    </AppShell>
  );
}
