import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router';
import {
  Alert,
  Badge,
  Button,
  Group,
  Loader,
  Modal,
  PasswordInput,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { MedplumClient } from '@medplum/core';
import type { AccessPolicy, Organization, Practitioner, PractitionerRole, ProjectMembership, Reference } from '@medplum/fhirtypes';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import { DEPARTMENTS, DEPT_SYSTEM, ROLES, ROLE_SYSTEM, deptName, roleName } from '../../lib/hospital.js';
import { PROJECT_ADMIN_ROLES, accessPolicyName, roleFromPolicyName } from '../../lib/access.js';

/**
 * Staff administration — /admin/staff. Lists staff (ProjectMembership +
 * PractitionerRole + department Organization), invites new staff, assigns
 * or changes department + role, and deactivates/reactivates staff.
 *
 * Where access is actually enforced: the SERVER. Each role maps to a
 * Medplum AccessPolicy ("HInS role: <code>", scripts/seed/
 * seed-access-policies.mjs); changing someone's role here re-points their
 * ProjectMembership.accessPolicy, which Medplum checks on every request.
 * Deactivating sets ProjectMembership.active = false — verified live that
 * this blocks new logins AND makes existing tokens fail (401) immediately.
 * Hiding this page from non-admins is cosmetic; the invite and membership
 * APIs return 403 for anyone who is not a project admin.
 *
 * Non-destructive: a role change ends the old PractitionerRole (active =
 * false, period.end = today) and creates a new one, so the staff history
 * stays queryable. Nothing is ever deleted.
 *
 * Known gaps, stated plainly:
 *   - Role change is several writes (membership, then old role(s), then new
 *     role), not atomic. Membership is written FIRST so enforcement never
 *     lags the displayed role; if a later write fails the page shows a
 *     "policy/role mismatch" badge so an admin can re-apply.
 *   - One active department+role per person. Real hospitals have people in
 *     two departments (e.g. a cardiologist covering ED); multiple active
 *     PractitionerRoles would need a combined AccessPolicy (basedOn).
 *   - Invite does not send email (no SMTP in dev). Without a password the
 *     invitee must use "forgot password" once email is configured.
 *   - No audit trail of who changed whose role beyond Medplum's resource
 *     history (meta.author on each version).
 */

const today = () => new Date().toISOString().slice(0, 10);

function roleCodeOf(pr: PractitionerRole): string | undefined {
  return pr.code?.flatMap((c) => c.coding ?? []).find((c) => c.system === ROLE_SYSTEM)?.code;
}

/** True if the signed-in user may see staff admin (project admin, or an active hospital-admin PractitionerRole). */
export function useCanManageStaff(): boolean {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const [hasAdminRole, setHasAdminRole] = useState(false);
  const isProjectAdmin = medplum.isProjectAdmin() || medplum.isSuperAdmin();
  useEffect(() => {
    if (isProjectAdmin || profile?.resourceType !== 'Practitioner') return;
    medplum
      .searchResources('PractitionerRole', {
        practitioner: `Practitioner/${profile.id}`,
        role: `${ROLE_SYSTEM}|hospital-admin`,
        active: 'true',
      })
      .then((r) => setHasAdminRole(r.length > 0))
      .catch(() => setHasAdminRole(false));
  }, [medplum, profile, isProjectAdmin]);
  return isProjectAdmin || hasAdminRole;
}

/** Nav button for ClinicianApp; renders nothing for non-admins. */
export function StaffNavButton() {
  const location = useLocation();
  if (!useCanManageStaff()) return null;
  return (
    <Button component={Link} to="/admin/staff" variant={location.pathname.startsWith('/admin') ? 'light' : 'subtle'} size="sm">
      Staff
    </Button>
  );
}

interface StaffRow {
  membership: ProjectMembership;
  name: string;
  email: string;
  active: boolean;
  policyRole?: string;
  roles: PractitionerRole[]; // HInS roles (ROLE_SYSTEM) for this practitioner, active first
}

interface Directory {
  rows: StaffRow[];
  depts: Organization[];
  policies: AccessPolicy[];
}

async function loadDirectory(medplum: MedplumClient): Promise<Directory> {
  const opts = { cache: 'reload' as const };
  const [members, roles, orgs, policies] = await Promise.all([
    medplum.searchResources('ProjectMembership', { _count: '1000' }, opts),
    medplum.searchResources('PractitionerRole', { _count: '1000' }, opts),
    medplum.searchResources('Organization', { identifier: `${DEPT_SYSTEM}|`, _count: '100' }, opts),
    medplum.searchResources('AccessPolicy', { _count: '100' }, opts),
  ]);
  const depts = orgs.filter((o) => o.identifier?.some((i) => i.system === DEPT_SYSTEM) && o.partOf);
  const policyById = new Map(policies.map((p) => [p.id, p]));
  const rows = members
    .filter((m) => m.profile?.reference?.startsWith('Practitioner/'))
    .map((m): StaffRow => {
      const policyId = m.accessPolicy?.reference?.split('/')[1];
      const myRoles = roles
        .filter((r) => r.practitioner?.reference === m.profile?.reference && roleCodeOf(r))
        .sort((a, b) => Number(b.active !== false) - Number(a.active !== false));
      return {
        membership: m,
        name: m.profile?.display ?? m.profile?.reference ?? '?',
        email: m.user?.display ?? '',
        active: m.active !== false,
        policyRole: roleFromPolicyName((policyId ? policyById.get(policyId)?.name : undefined) ?? m.accessPolicy?.display),
        roles: myRoles,
      };
    })
    .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
  return { rows, depts, policies };
}

export function StaffAdmin() {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const canManage = useCanManageStaff();
  const projectId = medplum.getProject()?.id;
  const [dir, setDir] = useState<Directory | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [assignFor, setAssignFor] = useState<StaffRow | undefined>();
  const [busy, setBusy] = useState<string | undefined>();

  const reload = useCallback(() => {
    loadDirectory(medplum)
      .then((d) => {
        setDir(d);
        setError(undefined);
      })
      .catch((err) => setError(String(err)));
  }, [medplum]);
  useEffect(reload, [reload]);

  const policyRef = useCallback(
    (role: string): Reference<AccessPolicy> => {
      const p = dir?.policies.find((x) => x.name === accessPolicyName(role));
      if (!p) throw new Error(`AccessPolicy "${accessPolicyName(role)}" not found — run scripts/seed/seed-access-policies.mjs`);
      return { reference: `AccessPolicy/${p.id}`, display: p.name };
    },
    [dir],
  );

  /** Membership writes go through the project admin API (403 for non-admins — server-enforced). */
  const saveMembership = useCallback(
    async (m: ProjectMembership, patch: Partial<ProjectMembership>) => {
      if (!projectId) throw new Error('No current project');
      const fresh = await medplum.get<ProjectMembership>(`admin/projects/${projectId}/members/${m.id}`, { cache: 'reload' });
      return medplum.post(`admin/projects/${projectId}/members/${m.id}`, { ...fresh, ...patch });
    },
    [medplum, projectId],
  );

  const endRoles = useCallback(
    async (roles: PractitionerRole[]) => {
      for (const r of roles.filter((x) => x.active !== false)) {
        const fresh = await medplum.readResource('PractitionerRole', r.id as string, { cache: 'reload' });
        await medplum.updateResource({ ...fresh, active: false, period: { ...fresh.period, end: today() } });
      }
    },
    [medplum],
  );

  const createRole = useCallback(
    async (practitioner: Reference<Practitioner>, role: string, deptCode: string) => {
      const org = dir?.depts.find((o) => o.identifier?.some((i) => i.system === DEPT_SYSTEM && i.value === deptCode));
      if (!org) throw new Error(`Department "${deptCode}" not seeded — run scripts/seed/seed-departments.mjs`);
      await medplum.createResource<PractitionerRole>({
        resourceType: 'PractitionerRole',
        active: true,
        period: { start: today() },
        practitioner,
        organization: { reference: `Organization/${org.id}`, display: org.name },
        code: [{ coding: [{ system: ROLE_SYSTEM, code: role, display: roleName(role) }], text: roleName(role) }],
      });
    },
    [medplum, dir],
  );

  async function run(key: string, fn: () => Promise<void>, ok: string) {
    setBusy(key);
    try {
      await fn();
      notifications.show({ message: ok, color: 'green' });
    } catch (err) {
      notifications.show({ message: `Failed: ${String(err)}`, color: 'red', autoClose: 10_000 });
    } finally {
      setBusy(undefined);
      reload();
    }
  }

  const deactivate = (row: StaffRow) =>
    run(
      row.membership.id as string,
      async () => {
        await saveMembership(row.membership, { active: false });
        await endRoles(row.roles);
      },
      `${row.name} deactivated — sign-in and existing sessions blocked`,
    );

  const reactivate = (row: StaffRow) =>
    run(
      row.membership.id as string,
      async () => {
        await saveMembership(row.membership, { active: true });
        // Restore the most recent role matching their access policy, if none is active.
        if (!row.roles.some((r) => r.active !== false)) {
          const last = row.roles
            .filter((r) => roleCodeOf(r) === row.policyRole)
            .sort((a, b) => (b.meta?.lastUpdated ?? '').localeCompare(a.meta?.lastUpdated ?? ''))[0];
          if (last) {
            const fresh = await medplum.readResource('PractitionerRole', last.id as string, { cache: 'reload' });
            await medplum.updateResource({ ...fresh, active: true, period: { start: today() } });
          }
        }
      },
      `${row.name} reactivated`,
    );

  if (!canManage) {
    return (
      <Alert color="gray" title="Staff administration">
        Only hospital administrators can manage staff. (The server enforces this too — the membership APIs reject
        non-admins.)
      </Alert>
    );
  }

  return (
    <Stack>
      <Group justify="space-between">
        <div>
          <Title order={3}>Staff</Title>
          <Text size="sm" c="dimmed">
            Department + role per person. Role sets the server-side access policy.
          </Text>
        </div>
        <Button onClick={() => setInviteOpen(true)} disabled={!dir}>
          Invite staff
        </Button>
      </Group>
      {error && <Alert color="red">{error}</Alert>}
      {!dir ? (
        <Loader size="sm" />
      ) : (
        <Table highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Name</Table.Th>
              <Table.Th>Email</Table.Th>
              <Table.Th>Department · Role</Table.Th>
              <Table.Th>Access policy</Table.Th>
              <Table.Th>Status</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {dir.rows.map((row) => {
              const activeRoles = row.roles.filter((r) => r.active !== false);
              const isSelf = row.membership.profile?.reference === `Practitioner/${profile?.id}`;
              const mismatch =
                row.active && row.policyRole && activeRoles.length > 0 && !activeRoles.some((r) => roleCodeOf(r) === row.policyRole);
              return (
                <Table.Tr key={row.membership.id} style={{ opacity: row.active ? 1 : 0.55 }}>
                  <Table.Td>
                    {row.name}
                    {row.membership.admin && (
                      <Badge ml="xs" size="xs" variant="outline">
                        project admin
                      </Badge>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{row.email}</Text>
                  </Table.Td>
                  <Table.Td>
                    {activeRoles.length === 0 ? (
                      <Text size="sm" c="dimmed">
                        Unassigned
                      </Text>
                    ) : (
                      activeRoles.map((r) => (
                        <Text size="sm" key={r.id}>
                          {r.organization?.display ?? '?'} · {roleName(roleCodeOf(r) ?? '')}
                        </Text>
                      ))
                    )}
                  </Table.Td>
                  <Table.Td>
                    {row.policyRole ? (
                      <Badge variant="light">{roleName(row.policyRole)}</Badge>
                    ) : (
                      <Text size="xs" c="dimmed">
                        {row.membership.accessPolicy?.display ?? (row.membership.admin ? 'Full (admin)' : 'None')}
                      </Text>
                    )}
                    {mismatch && (
                      <Badge ml="xs" color="orange" size="xs">
                        policy/role mismatch
                      </Badge>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Badge color={row.active ? 'green' : 'gray'}>{row.active ? 'Active' : 'Deactivated'}</Badge>
                  </Table.Td>
                  <Table.Td>
                    {isSelf ? (
                      <Text size="xs" c="dimmed">
                        you
                      </Text>
                    ) : (
                      <Group gap="xs" justify="flex-end" wrap="nowrap">
                        {row.active && (
                          <Button size="xs" variant="light" onClick={() => setAssignFor(row)}>
                            {activeRoles.length ? 'Change' : 'Assign'}
                          </Button>
                        )}
                        {row.active ? (
                          <Button size="xs" variant="subtle" color="red" loading={busy === row.membership.id} onClick={() => deactivate(row)}>
                            Deactivate
                          </Button>
                        ) : (
                          <Button size="xs" variant="subtle" loading={busy === row.membership.id} onClick={() => reactivate(row)}>
                            Reactivate
                          </Button>
                        )}
                      </Group>
                    )}
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      )}

      <AssignModal
        row={assignFor}
        onClose={() => setAssignFor(undefined)}
        onSave={(dept, role) => {
          const row = assignFor as StaffRow;
          setAssignFor(undefined);
          return run(
            row.membership.id as string,
            async () => {
              // Enforcement first: re-point the access policy, then the display records.
              await saveMembership(row.membership, { accessPolicy: policyRef(role), admin: PROJECT_ADMIN_ROLES.includes(role) });
              await endRoles(row.roles);
              await createRole(row.membership.profile as Reference<Practitioner>, role, dept);
            },
            `${row.name}: ${roleName(role)} @ ${deptName(dept)}`,
          );
        }}
      />

      <InviteModal
        opened={inviteOpen}
        onClose={() => setInviteOpen(false)}
        onInvite={async (v) => {
          if (!projectId) throw new Error('No current project');
          const result = await medplum.invite(projectId, {
            resourceType: 'Practitioner',
            firstName: v.firstName,
            lastName: v.lastName,
            email: v.email,
            password: v.password || undefined,
            sendEmail: false,
            membership: { accessPolicy: policyRef(v.role), admin: PROJECT_ADMIN_ROLES.includes(v.role) },
          });
          if (result.resourceType !== 'ProjectMembership' || !result.profile) throw new Error(JSON.stringify(result));
          await createRole(result.profile as Reference<Practitioner>, v.role, v.dept);
          setInviteOpen(false);
          notifications.show({ message: `Invited ${v.email} as ${roleName(v.role)} @ ${deptName(v.dept)}`, color: 'green' });
          reload();
        }}
      />
    </Stack>
  );
}

const deptOptions = DEPARTMENTS.map((d) => ({ value: d.code, label: d.name }));
const roleOptions = ROLES.map((r) => ({ value: r.code, label: r.name }));

function AssignModal({
  row,
  onClose,
  onSave,
}: {
  row: StaffRow | undefined;
  onClose: () => void;
  onSave: (dept: string, role: string) => void;
}) {
  const [dept, setDept] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  useEffect(() => {
    const current = row?.roles.find((r) => r.active !== false);
    setRole(current ? (roleCodeOf(current) ?? null) : (row?.policyRole ?? null));
    setDept(null);
  }, [row]);
  return (
    <Modal opened={!!row} onClose={onClose} title={`Department & role — ${row?.name ?? ''}`}>
      <Stack>
        <Select label="Department" data={deptOptions} value={dept} onChange={setDept} searchable required />
        <Select label="Role" data={roleOptions} value={role} onChange={setRole} required />
        <Text size="xs" c="dimmed">
          Saving switches their server-side access policy to “{role ? roleName(role) : '—'}” immediately and ends their
          current department role (kept in history).
        </Text>
        <Group justify="flex-end">
          <Button variant="subtle" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!dept || !role} onClick={() => dept && role && onSave(dept, role)}>
            Save
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

interface InviteValues {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  dept: string;
  role: string;
}

function InviteModal({
  opened,
  onClose,
  onInvite,
}: {
  opened: boolean;
  onClose: () => void;
  onInvite: (v: InviteValues) => Promise<void>;
}) {
  const empty: InviteValues = { firstName: '', lastName: '', email: '', password: '', dept: '', role: '' };
  const [v, setV] = useState<InviteValues>(empty);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | undefined>();
  useEffect(() => {
    if (opened) {
      setV(empty);
      setErr(undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);
  const valid = useMemo(() => v.firstName && v.lastName && /.+@.+\..+/.test(v.email) && v.dept && v.role, [v]);
  const set = (k: keyof InviteValues) => (val: string | null) => setV((s) => ({ ...s, [k]: val ?? '' }));
  return (
    <Modal opened={opened} onClose={onClose} title="Invite staff">
      <Stack>
        <Group grow>
          <TextInput label="First name" value={v.firstName} onChange={(e) => set('firstName')(e.currentTarget.value)} required />
          <TextInput label="Last name" value={v.lastName} onChange={(e) => set('lastName')(e.currentTarget.value)} required />
        </Group>
        <TextInput label="Email" value={v.email} onChange={(e) => set('email')(e.currentTarget.value)} required />
        <PasswordInput
          label="Initial password (optional)"
          description="Dev only — no invite email is sent. Leave blank only if email/password reset is configured."
          value={v.password}
          onChange={(e) => set('password')(e.currentTarget.value)}
        />
        <Select label="Department" data={deptOptions} value={v.dept || null} onChange={set('dept')} searchable required />
        <Select label="Role" data={roleOptions} value={v.role || null} onChange={set('role')} required />
        {err && <Alert color="red">{err}</Alert>}
        <Group justify="flex-end">
          <Button variant="subtle" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!valid}
            loading={saving}
            onClick={async () => {
              setSaving(true);
              setErr(undefined);
              try {
                await onInvite(v);
              } catch (e) {
                setErr(String(e));
              } finally {
                setSaving(false);
              }
            }}
          >
            Invite
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
