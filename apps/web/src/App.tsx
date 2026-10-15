import { Routes, Route, Navigate } from 'react-router';
import { Center, Paper, Title, Text, Stack } from '@mantine/core';
import { SignInForm, useMedplumProfile } from '@medplum/react';
import { ClinicianApp } from './pages/clinician/ClinicianApp.js';
import { PatientPortal } from './pages/patient/PatientPortal.js';

/**
 * Role split, docs/PLATFORM_BLUEPRINT.md §10: which app a signed-in user
 * sees is driven by their FHIR profile resourceType within the HInS Dev
 * project (Practitioner vs. Patient) -- not a separate role flag. A real
 * deployment layers RBAC roles (§10.1) on top of this for the many
 * practitioner sub-roles (nurse, lab tech, etc.); this MVP only
 * distinguishes the two broadest audiences the brief asked for.
 */
export function App() {
  const profile = useMedplumProfile();

  if (!profile) {
    return (
      <Center style={{ minHeight: '100vh' }}>
        <Paper withBorder shadow="sm" p="xl" w={420}>
          <Stack gap="xs" mb="md">
            <Title order={2}>HInS</Title>
            <Text c="dimmed" size="sm">
              Sign in as a clinician or a patient in the HInS Dev project.
            </Text>
          </Stack>
          <SignInForm onSuccess={() => window.location.reload()}>Sign in</SignInForm>
        </Paper>
      </Center>
    );
  }

  if (profile.resourceType === 'Practitioner') {
    return <ClinicianApp />;
  }

  if (profile.resourceType === 'Patient') {
    return <PatientPortal />;
  }

  return (
    <Routes>
      <Route
        path="*"
        element={
          <Center style={{ minHeight: '100vh' }}>
            <Text>
              Signed in as a {profile.resourceType}, which this MVP doesn't have a view for yet.
            </Text>
          </Center>
        }
      />
    </Routes>
  );
}

/** Small helper so both apps can bounce an unknown route home. */
export function CatchAll({ to }: { to: string }) {
  return <Navigate to={to} replace />;
}
