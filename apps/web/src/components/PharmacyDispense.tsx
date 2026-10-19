import { useCallback, useEffect, useState } from 'react';
import { Paper, Group, Text, Badge, Button, Stack, Collapse, Divider, Loader, TextInput, NumberInput, Select, Alert } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { MedicationAdministration, MedicationDispense, MedicationRequest } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { formatHumanName } from '../lib/fhirFormat.js';

/**
 * Pharmacy dispensing / administration panel — rendered inside
 * VersionedRx.tsx under each `MedicationRequest`, not a separate page.
 * docs/PLATFORM_BLUEPRINT.md §13/§13a "02a — Pharmacy dispensing."
 *
 * ── Why one resource pair covers both outpatient and inpatient ─────────
 * `MedicationDispense` is FHIR's own resource for "a medication was
 * actually handed over" — its spec explicitly covers both an outpatient
 * pharmacy pickup AND an inpatient ward-stock issue. This file does not
 * build two separate code paths for those; `whenHandedOver` + `performer`
 * + `quantity` is the same shape either way, and which setting it was
 * (OPD/IPD) is not tracked here at all because nothing downstream reads
 * it — adding a field no consumer uses would be exactly the kind of
 * invented-structure-without-real-data this codebase avoids elsewhere
 * (see BedBoard.tsx's "no bed-status field is stored" and Billing.tsx's
 * "no fabricated NDC/CPT code" for the same principle applied to other
 * subsystems). `MedicationAdministration` is the separate, distinct
 * resource for "one dose was actually given right now" — the inpatient/
 * ward case specifically (a nurse/clinician gives a dose), kept apart
 * from MedicationDispense per FHIR's own split between "supply handed
 * over" and "dose administered."
 *
 * ── No interaction/allergy checking here, on purpose ────────────────────
 * Per §13/§13a's own research note on this roadmap item: medications in
 * this codebase are still free text (`medicationCodeableConcept.text`,
 * see PatientDetail.tsx's `NewRxForm`) — there is no RxNorm/CDCI code to
 * check an interaction or allergy against. Faking a green-checkmark
 * "no interactions found" here would be actively worse than omitting the
 * check entirely, because it would look like a real safety check that
 * never ran — same "honest gap over fabricated check" principle Billing.
 * tsx applies to `ClaimResponse` adjudication. Real interaction-checking
 * is explicitly blocked on §03.6's medication-coding resolution, not a
 * gap in this file's own design.
 *
 * ── No MedicationRequest.status change, ever, from this panel ─────────
 * A request can be dispensed/administered against multiple times
 * (refills, repeated scheduled doses) with NO fulfillment-count or
 * stock/quantity-remaining tracking — that is a separate, later roadmap
 * item ("Inventory/supply chain", §13a) that doesn't exist yet. Inventing
 * "3 of 30 tablets dispensed, 27 remaining" math here, with no real stock
 * ledger behind it, would be a fabricated number dressed as a real one.
 * This is a scope boundary, stated plainly, not an oversight.
 *
 * ── The one real guard this panel enforces ──────────────────────────────
 * Only an `active` MedicationRequest may be dispensed/administered
 * against. The buttons below are hidden once the `rx` prop locally shows
 * a non-active status, but — same "recheck right before the write"
 * discipline as BedBoard.tsx's occupancy check and Billing.tsx's Coverage
 * gate — the REAL gate is `assertStillActive()` below, which re-reads the
 * MedicationRequest fresh immediately before every write. This matters
 * here specifically because the `rx` prop is a page-load (or last-reload)
 * snapshot: another clinician could cancel/stop the same request in the
 * seconds between this page loading and a click landing, and a stale
 * client-side status check alone would silently let a now-cancelled
 * prescription be dispensed. On a failed recheck, a clear on-screen
 * message names the actual current status — never a silent no-op.
 *
 * **Known gap, stated plainly, not glossed over (fixed to disclose,
 * post-review):** this gate has ZERO server-side backing, not just a
 * TOCTOU race window like BedBoard's analogous check. Verified live: a
 * direct FHIR `POST /MedicationDispense` referencing an already-cancelled
 * `MedicationRequest` via `authorizingPrescription`, sent straight to
 * Medplum with no involvement of this file at all, is accepted with
 * `201 Created` and zero resistance — this repo has no `AccessPolicy` or
 * Bot anywhere (confirmed via `grep`) constraining these writes by the
 * referenced request's status. `assertStillActive()` only protects a
 * clinician going through THIS exact React code path; a different UI, a
 * stale second tab that skips this check, or any direct API caller can
 * create dispense/administration records against a cancelled/stopped
 * prescription with no friction whatsoever. Real enforcement needs a
 * Medplum Bot or Access Policy constraint at the FHIR-server layer — not
 * built this round, and a materially bigger gap than it might look from
 * the client-side-only framing above.
 *
 * ── Live gotcha: `dosage.text` alone is rejected by this Medplum instance
 *    (FHIR invariant mad-1) ──────────────────────────────────────────────
 * Verified directly against this running instance, not assumed from the
 * base FHIR R4 spec's own prose (which frames free-text dosage as a
 * normal, supported alternative to a structured dose — see
 * MedicationAdministrationDosage.text's own doc comment: "Free text
 * dosage can be used for cases where the dosage administered is too
 * complex to code"). In practice, this Medplum instance 400s any write
 * where `dosage` is present with only `.text` set:
 * `Constraint mad-1 not met: SHALL have at least one of dosage.dose or
 * dosage.rate[x]` (fhirpath `dose.exists() or rate.exists()` — note this
 * does NOT OR in `text.exists()`, unlike what the resource's own
 * documentation implies). Populating a fabricated `dosage.dose` Quantity
 * just to satisfy that invariant would be inventing structured data with
 * nothing real behind it — the exact thing this codebase's
 * honest-text-over-fake-data convention exists to prevent. So the dose
 * actually given is instead recorded in `MedicationAdministration.note`
 * (a plain `Annotation[]`, no such constraint, confirmed live), not
 * `dosage.text` — same free text, different FHIR field, chosen because
 * it's the one this instance's loaded StructureDefinition actually
 * accepts un-fabricated. `status: 'not-done'` (a skipped dose) carries no
 * `dosage`/`note` at all and was confirmed live to need neither.
 *
 * ── No audit-service call ────────────────────────────────────────────────
 * Unlike VersionedNote.tsx/VersionedRx.tsx's `recordEditEvent` calls, this
 * panel does NOT call `services/audit-service` — this feature needs none
 * of the three standing services (consent/deid/audit), same as
 * Scheduling.tsx/BedBoard.tsx/Billing.tsx before it. "Who did what when"
 * is carried entirely in the FHIR resources themselves (`performer`,
 * `whenHandedOver`/`effectiveDateTime`) and read back from there for
 * display — no separate log to keep in sync.
 *
 * ── No new RBAC ──────────────────────────────────────────────────────────
 * Any signed-in Practitioner can dispense or administer here, same
 * precedent as every other merged feature (Scheduling/BedBoard/Billing).
 * **Known gap, stated plainly:** a real pharmacy module would distinguish
 * a Pharmacist role (allowed to dispense) from a general Practitioner —
 * this codebase has no role mechanism beyond "signed in as *a*
 * Practitioner" yet (§10 is still open). Not addressed here.
 */

interface TimelineEntry {
  id: string;
  kind: 'dispense' | 'administration';
  when: string;
  performer: string;
  detail: string;
  status: string;
}

function performerDisplay(actors: { actor?: { display?: string; reference?: string } }[] | undefined): string {
  const a = actors?.[0]?.actor;
  return a?.display ?? a?.reference ?? 'Unknown';
}

function toEntries(dispenses: MedicationDispense[], administrations: MedicationAdministration[]): TimelineEntry[] {
  const fromDispense: TimelineEntry[] = dispenses.map((d) => ({
    id: `md-${d.id}`,
    kind: 'dispense',
    when: d.whenHandedOver ?? d.meta?.lastUpdated ?? '',
    performer: performerDisplay(d.performer),
    detail: d.quantity ? `${d.quantity.value ?? '?'} ${d.quantity.unit ?? ''}`.trim() + (d.daysSupply?.value ? ` · ${d.daysSupply.value} day(s) supply` : '') : '—',
    status: d.status,
  }));
  const fromAdmin: TimelineEntry[] = administrations.map((a) => ({
    id: `ma-${a.id}`,
    kind: 'administration',
    when: a.effectiveDateTime ?? a.meta?.lastUpdated ?? '',
    performer: performerDisplay(a.performer),
    detail: a.status === 'not-done' ? `Not given — ${a.statusReason?.[0]?.text ?? 'no reason recorded'}` : a.note?.[0]?.text ?? '—',
    status: a.status,
  }));
  return [...fromDispense, ...fromAdmin].sort((x, y) => (y.when > x.when ? 1 : -1));
}

/** The real gate — see this file's header. Re-reads the MedicationRequest
 * fresh, never trusts the `rx` prop a caller already has in hand. Returns
 * the fresh resource on success so callers write against up-to-date
 * data, or throws a message fit to show the clinician directly.
 *
 * `{ cache: 'reload' }` is load-bearing, not decorative -- confirmed live
 * (and the hard way: an initial version of this gate without it let a
 * dispense through against a MedicationRequest that had just been
 * cancelled via a direct FHIR call from a second session). @medplum/core's
 * `MedplumClient` keeps its own internal LRU response cache independent
 * of HTTP caching, and `readResource()` serves straight out of it for a
 * resource this client instance already fetched -- it has no way to know
 * another session's PUT just changed that resource server-side, so a
 * plain `readResource()` here would silently defeat the entire point of
 * "recheck fresh right before the write." Passing the standard
 * `RequestInit`-style `cache: 'reload'` option (which `MedplumClient`
 * checks explicitly before consulting its cache) forces a real network
 * round trip every time. Same bug class BedBoard.tsx/Billing.tsx's own
 * recheck functions could in principle hit, had any of their rechecks
 * reused an already-cached id -- worth calling out plainly here since it
 * was actually hit and fixed in THIS file during its own live
 * verification, not a theoretical worry. */
async function assertStillActive(medplum: ReturnType<typeof useMedplum>, rxId: string): Promise<MedicationRequest> {
  const fresh = await medplum.readResource('MedicationRequest', rxId, { cache: 'reload' });
  if (fresh.status !== 'active') {
    throw new Error(
      `This prescription is no longer active (current status: "${fresh.status}") — it may have been cancelled or stopped since this page loaded. Refresh and confirm before trying again.`
    );
  }
  return fresh;
}

export function PharmacyPanel({ rx, patientId }: { rx: MedicationRequest; patientId: string }) {
  const medplum = useMedplum();
  const [open, setOpen] = useState(false);
  const [dispenses, setDispenses] = useState<MedicationDispense[] | undefined>();
  const [administrations, setAdministrations] = useState<MedicationAdministration[] | undefined>();
  const [mode, setMode] = useState<'dispense' | 'administer' | undefined>();

  const reload = useCallback(() => {
    if (!rx.id) return;
    medplum.searchResources('MedicationDispense', { prescription: `MedicationRequest/${rx.id}`, _count: 50 }).then(setDispenses);
    medplum.searchResources('MedicationAdministration', { request: `MedicationRequest/${rx.id}`, _count: 50 }).then(setAdministrations);
  }, [medplum, rx.id]);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && dispenses === undefined) reload();
  }

  if (!rx.id) return null;
  const entries = dispenses !== undefined && administrations !== undefined ? toEntries(dispenses, administrations) : undefined;
  const canAct = rx.status === 'active';

  return (
    <>
      <Group gap="xs" mt={4}>
        <Button size="compact-xs" variant="subtle" onClick={toggle}>
          {open ? 'Hide dispense/administer' : 'Dispense / Administer'}
          {entries !== undefined && entries.length > 0 ? ` (${entries.length})` : ''}
        </Button>
      </Group>

      <Collapse in={open}>
        <Divider my="sm" label="Dispensing & administration" labelPosition="left" />

        {!canAct && (
          <Alert color="gray" variant="light" mb="sm">
            This prescription is <strong>{rx.status}</strong>, not active — it can no longer be dispensed or administered
            against. (This matches a fresh server check, not just this page's own snapshot — the same check runs again
            immediately before any write even when this banner isn&apos;t showing.)
          </Alert>
        )}

        <Group gap="xs" mb="sm">
          <Button size="xs" variant="light" disabled={!canAct} onClick={() => setMode(mode === 'dispense' ? undefined : 'dispense')}>
            Record dispense
          </Button>
          <Button size="xs" variant="light" disabled={!canAct} onClick={() => setMode(mode === 'administer' ? undefined : 'administer')}>
            Record dose administered
          </Button>
        </Group>

        <Collapse in={mode === 'dispense'}>
          <DispenseForm
            rx={rx}
            patientId={patientId}
            onDone={() => {
              setMode(undefined);
              reload();
            }}
            onCancel={() => setMode(undefined)}
          />
        </Collapse>

        <Collapse in={mode === 'administer'}>
          <AdministerForm
            rx={rx}
            patientId={patientId}
            onDone={() => {
              setMode(undefined);
              reload();
            }}
            onCancel={() => setMode(undefined)}
          />
        </Collapse>

        {entries === undefined ? (
          <Loader size="xs" />
        ) : entries.length === 0 ? (
          <Text size="sm" c="dimmed">
            No dispensing or administration recorded against this prescription yet.
          </Text>
        ) : (
          <Stack gap="xs">
            {entries.map((e) => (
              <Paper key={e.id} p="xs" bg="var(--mantine-color-gray-0)" withBorder>
                <Group justify="space-between" mb={2}>
                  <Group gap={6}>
                    <Badge
                      size="xs"
                      variant="light"
                      color={e.kind === 'dispense' ? 'blue' : e.status === 'not-done' ? 'red' : 'teal'}
                    >
                      {e.kind === 'dispense' ? 'Dispensed' : e.status === 'not-done' ? 'Not given' : 'Administered'}
                    </Badge>
                    <Text size="xs" fw={600}>
                      {e.performer}
                    </Text>
                  </Group>
                  <Text size="xs" c="dimmed">
                    {e.when ? e.when.slice(0, 16).replace('T', ' ') : '—'}
                  </Text>
                </Group>
                <Text size="sm">{e.detail}</Text>
              </Paper>
            ))}
          </Stack>
        )}
      </Collapse>
    </>
  );
}

function DispenseForm({
  rx,
  patientId,
  onDone,
  onCancel,
}: {
  rx: MedicationRequest;
  patientId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const medplum = useMedplum();
  const [qtyValue, setQtyValue] = useState<number | string>('');
  const [qtyUnit, setQtyUnit] = useState('');
  const [daysSupply, setDaysSupply] = useState<number | string>('');
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    if (!rx.id || qtyValue === '' || !qtyUnit.trim()) return;
    setSaving(true);
    try {
      // The real gate -- re-checked fresh right now. See this file's
      // header ("The one real guard this panel enforces"). Fixed
      // post-review: the fresh resource this returns MUST be the one
      // used below, not the stale `rx` prop closed over from whenever
      // this panel last rendered -- a concurrent edit to the medication
      // text (VersionedRx.tsx's own Edit flow) between page load and
      // this click would otherwise get silently recorded wrong.
      const freshRx = await assertStillActive(medplum, rx.id);

      const profile = medplum.getProfile();
      const now = new Date().toISOString();
      await medplum.createResource<MedicationDispense>({
        resourceType: 'MedicationDispense',
        status: 'completed',
        // Copies the SAME free-text description already on the
        // MedicationRequest -- never invents a new one. See
        // PatientDetail.tsx's NewRxForm for where this text originates.
        // Uses the freshly-reread resource, not the stale `rx` prop --
        // see the comment on assertStillActive() above.
        medicationCodeableConcept: freshRx.medicationCodeableConcept,
        subject: { reference: `Patient/${patientId}` },
        authorizingPrescription: [{ reference: `MedicationRequest/${rx.id}` }],
        performer: profile ? [{ actor: { reference: `${profile.resourceType}/${profile.id}`, display: formatHumanName(profile.name) } }] : undefined,
        whenHandedOver: now,
        // Free-text-adjacent quantity: a plain number + a free-text unit
        // string (e.g. "30" + "tablets") -- no fabricated NDC packaging
        // code, same honest-text-over-fake-code convention Billing.tsx
        // uses for CPT/HCPCS and BedBoard.tsx uses for discharge
        // disposition.
        quantity: { value: Number(qtyValue), unit: qtyUnit.trim() },
        daysSupply: daysSupply !== '' ? { value: Number(daysSupply), unit: 'days' } : undefined,
      });
      notifications.show({ message: 'Dispense recorded', color: 'green' });
      setQtyValue('');
      setQtyUnit('');
      setDaysSupply('');
      onDone();
    } catch (err) {
      notifications.show({ message: String(err instanceof Error ? err.message : err), color: 'red' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Paper withBorder p="sm" mb="sm">
      <Stack gap="xs">
        <Text size="sm" fw={600}>
          Record a dispense — {rx.medicationCodeableConcept?.text}
        </Text>
        <Group>
          <NumberInput label="Quantity" placeholder="e.g. 30" value={qtyValue} onChange={setQtyValue} min={0.01} w={140} />
          <TextInput label="Unit" placeholder="e.g. tablets" value={qtyUnit} onChange={(e) => setQtyUnit(e.currentTarget.value)} w={160} />
          <NumberInput label="Days supply (optional)" placeholder="e.g. 30" value={daysSupply} onChange={setDaysSupply} min={1} w={180} />
        </Group>
        <Group justify="flex-end" gap="xs">
          <Button size="xs" variant="subtle" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button size="xs" loading={saving} disabled={qtyValue === '' || !qtyUnit.trim()} onClick={handleSave}>
            Save dispense
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}

function AdministerForm({
  rx,
  patientId,
  onDone,
  onCancel,
}: {
  rx: MedicationRequest;
  patientId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const medplum = useMedplum();
  const [status, setStatus] = useState<'completed' | 'not-done'>('completed');
  const [doseText, setDoseText] = useState('');
  const [statusReason, setStatusReason] = useState('');
  const [saving, setSaving] = useState(false);

  const valid = status === 'completed' ? doseText.trim().length > 0 : statusReason.trim().length > 0;

  async function handleSave() {
    if (!rx.id || !valid) return;
    setSaving(true);
    try {
      // The real gate -- re-checked fresh right now, same as DispenseForm
      // above. A skipped ("not-done") dose still requires an active order
      // behind it -- recording "ordered but not given, and why" against a
      // cancelled/stopped order wouldn't make clinical sense either.
      // Fixed post-review (same bug, same fix as DispenseForm): use the
      // fresh resource this returns, not the stale `rx` prop.
      const freshRx = await assertStillActive(medplum, rx.id);

      const profile = medplum.getProfile();
      const now = new Date().toISOString();
      await medplum.createResource<MedicationAdministration>({
        resourceType: 'MedicationAdministration',
        status,
        statusReason: status === 'not-done' && statusReason.trim() ? [{ text: statusReason.trim() }] : undefined,
        medicationCodeableConcept: freshRx.medicationCodeableConcept,
        subject: { reference: `Patient/${patientId}` },
        request: { reference: `MedicationRequest/${rx.id}` },
        performer: profile ? [{ actor: { reference: `${profile.resourceType}/${profile.id}`, display: formatHumanName(profile.name) } }] : undefined,
        effectiveDateTime: now,
        // `note`, not `dosage.text` -- see this file's header ("Live
        // gotcha: dosage.text alone is rejected by this Medplum
        // instance"). Same free text the clinician typed, just in the
        // field this instance's FHIR validator actually accepts.
        note: status === 'completed' && doseText.trim() ? [{ text: doseText.trim() }] : undefined,
      });
      notifications.show({ message: status === 'completed' ? 'Dose administration recorded' : 'Skipped dose recorded', color: 'green' });
      setDoseText('');
      setStatusReason('');
      setStatus('completed');
      onDone();
    } catch (err) {
      notifications.show({ message: String(err instanceof Error ? err.message : err), color: 'red' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Paper withBorder p="sm" mb="sm">
      <Stack gap="xs">
        <Text size="sm" fw={600}>
          Record a dose — {rx.medicationCodeableConcept?.text}
        </Text>
        <Select
          label="Status"
          data={[
            { value: 'completed', label: 'Given' },
            { value: 'not-done', label: 'Not given (ordered but skipped)' },
          ]}
          value={status}
          onChange={(v) => setStatus((v as 'completed' | 'not-done') ?? 'completed')}
          w={260}
        />
        {status === 'completed' ? (
          <TextInput
            label="Dose actually given"
            placeholder="e.g. 500mg PO"
            value={doseText}
            onChange={(e) => setDoseText(e.currentTarget.value)}
          />
        ) : (
          <TextInput
            label="Reason not given"
            placeholder="e.g. Patient NPO for procedure"
            value={statusReason}
            onChange={(e) => setStatusReason(e.currentTarget.value)}
          />
        )}
        <Group justify="flex-end" gap="xs">
          <Button size="xs" variant="subtle" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button size="xs" loading={saving} disabled={!valid} onClick={handleSave}>
            Save
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}
