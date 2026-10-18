import { useCallback, useEffect, useState } from 'react';
import {
  Stack,
  Group,
  Title,
  Paper,
  TextInput,
  Select,
  Button,
  Table,
  Text,
  Loader,
  Badge,
  Modal,
  Divider,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { Encounter, EncounterLocation, Location as FhirLocation, Patient } from '@medplum/fhirtypes';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import { formatHumanName, formatPatientMrn } from '../../lib/fhirFormat.js';

/**
 * BedBoard — docs/PLATFORM_BLUEPRINT.md §13/§13a's "bed/ward management"
 * roadmap item (§13a explicitly flags this as needing its OWN
 * capacity-reservation design, "does not inherit from the existing
 * practitioner-double-booking work"). This is that design, built directly
 * against `@medplum/core`, no new backend service — same pattern as
 * Scheduling.tsx (Appointment) and PatientDetail.tsx (Encounter/Condition/
 * Observation/MedicationRequest): this app talks to Medplum's FHIR API
 * straight from the browser.
 *
 * ── Data model ──────────────────────────────────────────────────────────
 * Two-level `Location` hierarchy via `Location.partOf`: a ward Location
 * (`physicalType` code `wa`) and bed Locations under it (`physicalType`
 * code `bd`, `partOf` -> the ward). Seeded by scripts/seed/seed-beds.mjs.
 * No search param for `physicalType` exists in base FHIR R4's Location
 * SearchParameter set, so wards/beds are distinguished by filtering the
 * full Location list client-side on `physicalType.coding[0].code` — the
 * same "don't trust a server param to narrow what you actually need,
 * check client-side" caution this file applies to Encounter.location
 * below, just for a different field.
 *
 * An admission is a single, long-lived `Encounter`:
 *   - `class`: the same `IMP` (inpatient) coding PatientDetail.tsx already
 *     uses for its note-taking "IPD" setting — reused verbatim, not
 *     reinvented.
 *   - `status: 'in-progress'` for the whole stay, `'finished'` only at
 *     actual discharge.
 *   - `location: EncounterLocation[]` — a REPEATING list. Admission
 *     pushes the first entry; a transfer closes the current (last) entry
 *     by setting its `period.end` and pushes a new one; discharge closes
 *     the last entry and finishes the Encounter. This list is therefore a
 *     complete, non-destructive history of every bed this admission ever
 *     occupied — nothing is ever removed or overwritten, only appended to
 *     or closed (same non-destructive convention as Scheduling.tsx's
 *     cancel-by-status-flip and VersionedNote.tsx/VersionedRx.tsx's
 *     edit-by-new-version).
 *
 * ── CRITICAL: this is NOT the same Encounter concept PatientDetail.tsx
 *    already creates ──────────────────────────────────────────────────
 * PatientDetail.tsx's note-taking flow also creates an `Encounter` with
 * `class: IMP` when a clinician tags a note "IPD" — but that Encounter is
 * created with `status: 'finished'` IMMEDIATELY, as a one-shot wrapper
 * around a single note, never touched again. It is NOT a long-lived
 * admission record and has no `location`. This file's admission Encounter
 * is a SEPARATE, NEW kind of Encounter, created only by Admit below, that
 * stays `in-progress` for the whole stay. **Known gap, stated plainly, not
 * hidden:** these two are not linked. A real admission's IPD notes
 * (written via PatientDetail.tsx during the stay) are NOT associated with
 * this admission Encounter today — a clinician writing a note during an
 * admission still gets a brand-new, separate, immediately-`finished`
 * note-Encounter, same as before this file existed. Linking the two (e.g.
 * notes taken during an admission referencing this Encounter via
 * `DocumentReference.context.encounter`, or notes created here reusing
 * this Encounter instead of making their own) is a reasonable future
 * improvement, deliberately left out of scope this round to avoid risking
 * the existing, working note-taking feature.
 *
 * ── Occupancy derivation — the actual point of this file ───────────────
 * There is NO parallel "bed status" field anywhere, and none should ever
 * be added: occupancy is always DERIVED from Encounter, live, never
 * cached/stored redundantly. A bed is occupied right now if and only if
 * there exists an `Encounter` with `status: 'in-progress'` whose
 * `location` array's LAST entry (by this file's own append-only
 * invariant, the last entry is always the only one that can still be
 * open) references that bed AND has no `period.end` set.
 *
 * This was verified against the LIVE Medplum instance before relying on
 * it, not assumed: `GET /fhir/R4/Encounter?location=Location/<bed>&status=
 * in-progress` does NOT mean "this bed is the currently-open one" — it
 * only means "this bed appears somewhere in this in-progress Encounter's
 * location list." Confirmed live: an in-progress Encounter that was
 * TRANSFERRED OUT of bed X (X now sits as an old, closed entry; a
 * different bed Y is the current open entry) still matches a search for
 * `location=Location/<X>&status=in-progress` — Medplum's `location`
 * search param matches "appears anywhere in the list," exactly as FHIR's
 * own param semantics generally work, not "is the currently active one."
 * `isBedCurrentlyOccupied()` below does the real check client-side after
 * that search: it finds the matching Encounter(s) and additionally
 * requires that bed to be the one in the LAST (open, no `period.end`)
 * location entry, not just present somewhere in the array.
 *
 * ── Known limitation: check-then-write is not atomic ───────────────────
 * (Not the same gap Scheduling.tsx documents — that file's own caveat is
 * that same-PATIENT double-booking across different practitioners isn't
 * checked at all; it has no TOCTOU/non-atomicity language. This is a
 * distinct, new limitation, specific to this file.)
 * The occupancy check-then-create/transfer is NOT atomic. This is a
 * direct browser-to-FHIR flow with no backend service or DB constraint to
 * lean on, so two concurrent admit/transfer attempts into the same bed
 * could theoretically both pass the "is it free?" check before either
 * write lands, landing two patients in the same bed. A real fix needs
 * either a server-side conditional-update/transaction guarantee or a
 * dedicated capacity-reservation resource (§13a's own note that a
 * `Location` on an `Appointment` doesn't reserve capacity, and that this
 * needs its own design rather than inheriting Scheduling.tsx's). Out of
 * scope for this round; the per-action recheck immediately before each
 * write (see handleAdmit/handleTransfer below) narrows the window as much
 * as a pure client-side check can, but does not close it.
 *
 * ── Scope ────────────────────────────────────────────────────────────────
 * Clinician-facing only. No patient-portal work this round (patients have
 * no reason to see a hospital-wide bed census) — stated explicitly as
 * out of scope, not an oversight. No new RBAC: any signed-in Practitioner
 * can admit/transfer/discharge, same as any signed-in Practitioner can
 * book/cancel an Appointment in Scheduling.tsx today.
 */

const LOCATION_PHYSICAL_TYPE_SYSTEM = 'http://terminology.hl7.org/CodeSystem/location-physical-type';
const ENCOUNTER_CLASS_IMP = { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'IMP', display: 'inpatient encounter' };

const DISPOSITIONS = [
  { value: 'home', label: 'Home' },
  { value: 'transferred', label: 'Transferred (to another facility)' },
  { value: 'deceased', label: 'Deceased' },
  { value: 'other', label: 'Other' },
];

interface Ward {
  location: FhirLocation;
  beds: FhirLocation[];
}

/** The last entry in an Encounter.location array is, by this file's own
 * write invariant (admit pushes one entry; transfer closes the last and
 * pushes a new one; nothing else ever touches this array), the only
 * entry that can still be open. Returns it only if it actually has no
 * `period.end` — never assumes without checking, since an Encounter
 * could in principle have been written by something other than this
 * file's own code. */
function openLocationEntry(encounter: Encounter): EncounterLocation | undefined {
  const entries = encounter.location;
  if (!entries || entries.length === 0) return undefined;
  const last = entries[entries.length - 1];
  return last.period?.end ? undefined : last;
}

function bedIdFromRef(ref: string | undefined): string | undefined {
  return ref?.startsWith('Location/') ? ref.slice('Location/'.length) : undefined;
}

/** Builds a census map: bed Location id -> the in-progress Encounter
 * currently occupying it. Loads every in-progress Encounter ONCE (not one
 * search per bed — this is the efficient bulk form of the same "last
 * open entry" check `isBedCurrentlyOccupied` does per-bed below right
 * before a write). */
async function loadCensus(medplum: ReturnType<typeof useMedplum>): Promise<Map<string, Encounter>> {
  const inProgress = await medplum.searchResources('Encounter', { status: 'in-progress', _count: 200 });
  const map = new Map<string, Encounter>();
  for (const encounter of inProgress) {
    const open = openLocationEntry(encounter);
    const bedId = bedIdFromRef(open?.location?.reference);
    if (bedId) map.set(bedId, encounter);
  }
  return map;
}

/** The precise, single-bed occupancy check described in this file's
 * header: narrows server-side on `status`+`location` (confirmed live that
 * this does NOT by itself mean "currently open" — see header), then
 * requires client-side that the matching Encounter's open (last,
 * no-period.end) location entry is actually THIS bed. Used right before
 * every admit/transfer write — not the census snapshot, which could be a
 * few seconds stale by the time the user clicks a button. */
async function isBedCurrentlyOccupied(medplum: ReturnType<typeof useMedplum>, bedId: string): Promise<boolean> {
  const candidates = await medplum.searchResources('Encounter', { status: 'in-progress', location: `Location/${bedId}` });
  return candidates.some((encounter) => bedIdFromRef(openLocationEntry(encounter)?.location?.reference) === bedId);
}

export function BedBoard() {
  const medplum = useMedplum();
  const [wards, setWards] = useState<Ward[] | undefined>();
  const [census, setCensus] = useState<Map<string, Encounter> | undefined>();

  const reload = useCallback(() => {
    medplum.searchResources('Location', { _count: 200 }).then((locations) => {
      const wardLocations = locations.filter((l) => l.physicalType?.coding?.[0]?.code === 'wa');
      const bedLocations = locations.filter((l) => l.physicalType?.coding?.[0]?.code === 'bd');
      const builtWards: Ward[] = wardLocations.map((w) => ({
        location: w,
        beds: bedLocations.filter((b) => b.partOf?.reference === `Location/${w.id}`),
      }));
      setWards(builtWards);
    });
    loadCensus(medplum).then(setCensus);
  }, [medplum]);

  useEffect(reload, [reload]);

  const [actionBed, setActionBed] = useState<FhirLocation | undefined>();
  const [actionMode, setActionMode] = useState<'admit' | 'transfer' | 'discharge' | undefined>();

  function openAdmit(bed: FhirLocation) {
    setActionBed(bed);
    setActionMode('admit');
  }
  function openTransfer(bed: FhirLocation) {
    setActionBed(bed);
    setActionMode('transfer');
  }
  function openDischarge(bed: FhirLocation) {
    setActionBed(bed);
    setActionMode('discharge');
  }
  function closeAction() {
    setActionBed(undefined);
    setActionMode(undefined);
  }

  const allBeds = (wards ?? []).flatMap((w) => w.beds);

  return (
    <Stack maw={960}>
      <Title order={3}>Bed / ward board</Title>
      <Text size="sm" c="dimmed">
        Census derived live from <code>Encounter.location</code> — see this file&apos;s header comment for the full
        design. No bed-status field is stored anywhere; what you see below is recomputed on every load.
      </Text>

      {wards === undefined || census === undefined ? (
        <Loader size="sm" />
      ) : wards.length === 0 ? (
        <Text c="dimmed">
          No wards/beds found. Run <code>node scripts/seed/seed-beds.mjs</code> against this Medplum instance.
        </Text>
      ) : (
        <Stack gap="lg">
          {wards.map((ward) => (
            <Paper key={ward.location.id} withBorder p="md">
              <Title order={5} mb="sm">
                {ward.location.name}
              </Title>
              <Table highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Bed</Table.Th>
                    <Table.Th>Status</Table.Th>
                    <Table.Th>Patient</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {ward.beds.map((bed) => {
                    const encounter = bed.id ? census.get(bed.id) : undefined;
                    const occupied = Boolean(encounter);
                    return (
                      <Table.Tr key={bed.id}>
                        <Table.Td>{bed.name}</Table.Td>
                        <Table.Td>
                          <Badge size="sm" color={occupied ? 'red' : 'green'} variant="light">
                            {occupied ? 'Occupied' : 'Free'}
                          </Badge>
                        </Table.Td>
                        <Table.Td>{encounter?.subject?.display ?? (occupied ? encounter?.subject?.reference : '—')}</Table.Td>
                        <Table.Td>
                          <Group gap="xs" justify="flex-end">
                            {!occupied && (
                              <Button size="xs" variant="light" onClick={() => openAdmit(bed)}>
                                Admit
                              </Button>
                            )}
                            {occupied && (
                              <>
                                <Button size="xs" variant="light" onClick={() => openTransfer(bed)}>
                                  Transfer
                                </Button>
                                <Button size="xs" variant="light" color="orange" onClick={() => openDischarge(bed)}>
                                  Discharge
                                </Button>
                              </>
                            )}
                          </Group>
                        </Table.Td>
                      </Table.Tr>
                    );
                  })}
                </Table.Tbody>
              </Table>
            </Paper>
          ))}
        </Stack>
      )}

      <Modal opened={actionMode === 'admit'} onClose={closeAction} title={actionBed ? `Admit into ${actionBed.name}` : 'Admit'}>
        {actionBed && (
          <AdmitForm
            bed={actionBed}
            onDone={() => {
              closeAction();
              reload();
            }}
            onCancel={closeAction}
          />
        )}
      </Modal>

      <Modal
        opened={actionMode === 'transfer'}
        onClose={closeAction}
        title={actionBed ? `Transfer out of ${actionBed.name}` : 'Transfer'}
      >
        {actionBed && census && actionBed.id && census.get(actionBed.id) && (
          <TransferForm
            fromBed={actionBed}
            encounter={census.get(actionBed.id) as Encounter}
            allBeds={allBeds}
            census={census}
            onDone={() => {
              closeAction();
              reload();
            }}
            onCancel={closeAction}
          />
        )}
      </Modal>

      <Modal
        opened={actionMode === 'discharge'}
        onClose={closeAction}
        title={actionBed ? `Discharge from ${actionBed.name}` : 'Discharge'}
      >
        {actionBed && census && actionBed.id && census.get(actionBed.id) && (
          <DischargeForm
            bed={actionBed}
            encounter={census.get(actionBed.id) as Encounter}
            onDone={() => {
              closeAction();
              reload();
            }}
            onCancel={closeAction}
          />
        )}
      </Modal>
    </Stack>
  );
}

function AdmitForm({ bed, onDone, onCancel }: { bed: FhirLocation; onDone: () => void; onCancel: () => void }) {
  const medplum = useMedplum();
  const profile = useMedplumProfile();

  const [selectedPatient, setSelectedPatient] = useState<Patient | undefined>();
  const [patientQuery, setPatientQuery] = useState('');
  const [patientResults, setPatientResults] = useState<Patient[] | undefined>();
  const [saving, setSaving] = useState(false);

  // Live patient search-as-you-type, same pattern as Scheduling.tsx /
  // PatientList.tsx.
  useEffect(() => {
    if (selectedPatient || !patientQuery.trim()) {
      setPatientResults(undefined);
      return;
    }
    let cancelled = false;
    medplum.searchResources('Patient', { name: patientQuery, _count: 10 }).then((result) => {
      if (!cancelled) setPatientResults(result);
    });
    return () => {
      cancelled = true;
    };
  }, [medplum, patientQuery, selectedPatient]);

  async function handleAdmit() {
    if (!selectedPatient?.id || !bed.id) return;
    setSaving(true);
    try {
      // Recheck occupancy right now -- the census the user clicked from
      // could be a few seconds stale. See this file's header for why this
      // check still isn't atomic even so.
      if (await isBedCurrentlyOccupied(medplum, bed.id)) {
        notifications.show({
          message: `${bed.name} is no longer free -- someone else was just admitted into it. Pick a different bed.`,
          color: 'red',
        });
        return;
      }

      const now = new Date().toISOString();
      await medplum.createResource({
        resourceType: 'Encounter',
        status: 'in-progress',
        class: ENCOUNTER_CLASS_IMP,
        subject: { reference: `Patient/${selectedPatient.id}`, display: formatHumanName(selectedPatient.name) },
        participant:
          profile?.resourceType === 'Practitioner' ? [{ individual: { reference: `Practitioner/${profile.id}` } }] : undefined,
        period: { start: now },
        location: [{ location: { reference: `Location/${bed.id}`, display: bed.name }, status: 'active', period: { start: now } }],
      });
      notifications.show({ message: `${formatHumanName(selectedPatient.name)} admitted into ${bed.name}`, color: 'green' });
      onDone();
    } catch (err) {
      notifications.show({ message: String(err), color: 'red' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Stack gap="sm">
      {selectedPatient ? (
        <Group justify="space-between">
          <Text>
            Patient:{' '}
            <Text span fw={600}>
              {formatHumanName(selectedPatient.name)}
            </Text>{' '}
            <Text span c="dimmed" size="sm">
              (MRN {formatPatientMrn(selectedPatient)})
            </Text>
          </Text>
          <Button size="xs" variant="subtle" onClick={() => setSelectedPatient(undefined)}>
            Change
          </Button>
        </Group>
      ) : (
        <Stack gap={4}>
          <TextInput
            label="Patient"
            placeholder="Search by name…"
            value={patientQuery}
            onChange={(e) => setPatientQuery(e.currentTarget.value)}
          />
          {patientResults !== undefined && (
            <Paper withBorder p="xs">
              {patientResults.length === 0 ? (
                <Text size="sm" c="dimmed">
                  No matches.
                </Text>
              ) : (
                <Stack gap={2}>
                  {patientResults.map((p) => (
                    <Text
                      key={p.id}
                      size="sm"
                      style={{ cursor: 'pointer' }}
                      onClick={() => {
                        setSelectedPatient(p);
                        setPatientResults(undefined);
                      }}
                    >
                      {formatHumanName(p.name)}{' '}
                      <Text span c="dimmed">
                        ({formatPatientMrn(p)})
                      </Text>
                    </Text>
                  ))}
                </Stack>
              )}
            </Paper>
          )}
        </Stack>
      )}

      <Group justify="flex-end">
        <Button variant="subtle" onClick={onCancel}>
          Cancel
        </Button>
        <Button loading={saving} disabled={!selectedPatient} onClick={handleAdmit}>
          Admit
        </Button>
      </Group>
    </Stack>
  );
}

function TransferForm({
  fromBed,
  encounter,
  allBeds,
  census,
  onDone,
  onCancel,
}: {
  fromBed: FhirLocation;
  encounter: Encounter;
  allBeds: FhirLocation[];
  census: Map<string, Encounter>;
  onDone: () => void;
  onCancel: () => void;
}) {
  const medplum = useMedplum();
  const [toBedId, setToBedId] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  const freeBeds = allBeds.filter((b) => b.id && b.id !== fromBed.id && !census.get(b.id));

  async function handleTransfer() {
    if (!toBedId || !fromBed.id || !encounter.id) return;
    const toBed = allBeds.find((b) => b.id === toBedId);
    if (!toBed) return;
    setSaving(true);
    try {
      // Same recheck-right-before-write as handleAdmit, against the NEW
      // (destination) bed.
      if (await isBedCurrentlyOccupied(medplum, toBedId)) {
        notifications.show({
          message: `${toBed.name} is no longer free -- pick a different bed.`,
          color: 'red',
        });
        return;
      }

      const now = new Date().toISOString();
      const entries = [...(encounter.location ?? [])];
      const openIdx = entries.length - 1;
      if (openIdx < 0 || entries[openIdx].period?.end) {
        // Shouldn't happen -- this form only opens for a bed the census
        // says is occupied, which means an open entry must exist. Fail
        // loudly rather than silently corrupting the location history.
        throw new Error('No open location entry found on this Encounter -- cannot transfer.');
      }
      entries[openIdx] = { ...entries[openIdx], period: { ...entries[openIdx].period, end: now } };
      entries.push({ location: { reference: `Location/${toBed.id}`, display: toBed.name }, status: 'active', period: { start: now } });

      await medplum.updateResource<Encounter>({ ...encounter, location: entries });
      notifications.show({ message: `Transferred from ${fromBed.name} to ${toBed.name}`, color: 'green' });
      onDone();
    } catch (err) {
      notifications.show({ message: String(err), color: 'red' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Stack gap="sm">
      <Text size="sm">
        Patient: <Text span fw={600}>{encounter.subject?.display ?? encounter.subject?.reference}</Text>
      </Text>
      <Select
        label="Transfer to"
        placeholder="Select a free bed"
        data={freeBeds.map((b) => ({ value: b.id as string, label: b.name ?? b.id ?? '' }))}
        value={toBedId}
        onChange={(v) => setToBedId(v ?? undefined)}
        searchable
      />
      {freeBeds.length === 0 && (
        <Text size="sm" c="dimmed">
          No free beds available right now.
        </Text>
      )}
      <Group justify="flex-end">
        <Button variant="subtle" onClick={onCancel}>
          Cancel
        </Button>
        <Button loading={saving} disabled={!toBedId} onClick={handleTransfer}>
          Transfer
        </Button>
      </Group>
    </Stack>
  );
}

function DischargeForm({
  bed,
  encounter,
  onDone,
  onCancel,
}: {
  bed: FhirLocation;
  encounter: Encounter;
  onDone: () => void;
  onCancel: () => void;
}) {
  const medplum = useMedplum();
  const [disposition, setDisposition] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  async function handleDischarge() {
    if (!disposition || !encounter.id) return;
    setSaving(true);
    try {
      // Re-fetch right before writing, same as handleAdmit/handleTransfer's
      // isBedCurrentlyOccupied() recheck -- the `encounter` prop is a
      // snapshot from page load and could be stale (e.g. a concurrent
      // discharge of the same patient already closed it). Operate on the
      // fresh copy, not the closure's.
      const current = await medplum.readResource('Encounter', encounter.id);
      if (current.status !== 'in-progress') {
        throw new Error('This admission is no longer in progress -- someone else may have already discharged it. Refresh and try again.');
      }
      const now = new Date().toISOString();
      const entries = [...(current.location ?? [])];
      const openIdx = entries.length - 1;
      if (openIdx < 0 || entries[openIdx].period?.end) {
        throw new Error('No open location entry found on this Encounter -- cannot discharge.');
      }
      entries[openIdx] = { ...entries[openIdx], period: { ...entries[openIdx].period, end: now } };

      const dispositionLabel = DISPOSITIONS.find((d) => d.value === disposition)?.label ?? disposition;
      await medplum.updateResource<Encounter>({
        ...current,
        status: 'finished',
        location: entries,
        period: { ...current.period, end: now },
        // Free-text .text only, deliberately -- no coded value. No
        // discharge-disposition terminology is wired up anywhere in this
        // codebase yet (same honest-text-over-fake-code choice
        // scripts/seed/seed-demo-data.mjs documents for MedicationRequest).
        hospitalization: { ...encounter.hospitalization, dischargeDisposition: { text: dispositionLabel } },
      });
      notifications.show({ message: `Discharged from ${bed.name} (${dispositionLabel})`, color: 'green' });
      onDone();
    } catch (err) {
      notifications.show({ message: String(err), color: 'red' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Stack gap="sm">
      <Text size="sm">
        Patient: <Text span fw={600}>{encounter.subject?.display ?? encounter.subject?.reference}</Text>
      </Text>
      <Select
        label="Discharge disposition"
        placeholder="Select…"
        data={DISPOSITIONS}
        value={disposition}
        onChange={(v) => setDisposition(v ?? undefined)}
      />
      <Divider />
      <Group justify="flex-end">
        <Button variant="subtle" onClick={onCancel}>
          Cancel
        </Button>
        <Button color="orange" loading={saving} disabled={!disposition} onClick={handleDischarge}>
          Discharge
        </Button>
      </Group>
    </Stack>
  );
}
