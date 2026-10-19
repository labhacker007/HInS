import { Routes, Route, Link, useLocation, useNavigate } from 'react-router';
import { AppShell, Group, Title, Button, Text } from '@mantine/core';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import { PatientList } from './PatientList.js';
import { NewPatient } from './NewPatient.js';
import { PatientDetail } from './PatientDetail.js';
import { Scheduling } from './Scheduling.js';
import { BedBoard } from './BedBoard.js';
import { Billing } from './Billing.js';
import { StaffAdmin, StaffNavButton } from '../admin/StaffAdmin.js';
import { CatchAll } from '../../App.js';
import { NotificationBell } from '../../components/NotificationBell.js';

export function ClinicianApp() {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const navigate = useNavigate();
  const location = useLocation();

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
            <Group gap="xs">
              <Button
                component={Link}
                to="/"
                variant={location.pathname === '/' || location.pathname.startsWith('/patients') ? 'light' : 'subtle'}
                size="sm"
              >
                Patients
              </Button>
              <Button
                component={Link}
                to="/schedule"
                variant={location.pathname.startsWith('/schedule') ? 'light' : 'subtle'}
                size="sm"
              >
                Schedule
              </Button>
              <Button
                component={Link}
                to="/beds"
                variant={location.pathname.startsWith('/beds') ? 'light' : 'subtle'}
                size="sm"
              >
                Beds
              </Button>
              <Button
                component={Link}
                to="/billing"
                variant={location.pathname.startsWith('/billing') ? 'light' : 'subtle'}
                size="sm"
              >
                Billing
              </Button>
              <StaffNavButton />
            </Group>
            <Text size="sm" c="dimmed">
              {profile?.resourceType === 'Practitioner' &&
                `Dr. ${profile.name?.[0]?.given?.[0] ?? ''} ${profile.name?.[0]?.family ?? ''}`.trim()}
            </Text>
          </Group>
          <Group gap="sm">
            <NotificationBell practitionerId={profile?.id} accessToken={medplum.getAccessToken()} />
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
          <Route path="/schedule" element={<Scheduling />} />
          <Route path="/beds" element={<BedBoard />} />
          <Route path="/billing" element={<Billing />} />
          <Route path="/admin/staff" element={<StaffAdmin />} />
          <Route path="*" element={<CatchAll to="/" />} />
        </Routes>
      </AppShell.Main>
    </AppShell>
  );
}
