import { Routes, Route, Link, useLocation, useNavigate } from 'react-router';
import { AppShell, Group, Title, Button, Tabs } from '@mantine/core';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import { MyRecords } from './MyRecords.js';
import { MyConsents } from './MyConsents.js';
import { CatchAll } from '../../App.js';
import { formatHumanName } from '../../lib/fhirFormat.js';

export function PatientPortal() {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <AppShell header={{ height: 96 }} padding="md">
      <AppShell.Header>
        <Group h={60} px="md" justify="space-between">
          <Title order={4}>
            <Link to="/" style={{ textDecoration: 'none', color: 'inherit' }}>
              HInS — My Health
            </Link>
          </Title>
          <Group>
            {profile && <span>{formatHumanName(profile.name)}</span>}
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
        <Tabs
          value={location.pathname.startsWith('/consents') ? 'consents' : 'records'}
          onChange={(value) => navigate(value === 'consents' ? '/consents' : '/')}
          px="md"
        >
          <Tabs.List>
            <Tabs.Tab value="records">My Records</Tabs.Tab>
            <Tabs.Tab value="consents">My Consents</Tabs.Tab>
          </Tabs.List>
        </Tabs>
      </AppShell.Header>
      <AppShell.Main>
        <Routes>
          <Route path="/" element={<MyRecords />} />
          <Route path="/consents" element={<MyConsents />} />
          <Route path="*" element={<CatchAll to="/" />} />
        </Routes>
      </AppShell.Main>
    </AppShell>
  );
}
