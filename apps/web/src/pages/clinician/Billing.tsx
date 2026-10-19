import { useCallback, useEffect, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router';
import {
  Stack,
  Group,
  Title,
  Paper,
  TextInput,
  NumberInput,
  Select,
  Button,
  Table,
  Text,
  Loader,
  Badge,
  Modal,
  Divider,
  Checkbox,
  Tooltip,
  Alert,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { Account, ChargeItem, Claim, Coverage, Encounter, Invoice, Money, Organization, Patient } from '@medplum/fhirtypes';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import { formatHumanName, formatPatientMrn } from '../../lib/fhirFormat.js';

/**
 * Billing — docs/PLATFORM_BLUEPRINT.md §13/§13a's "03 — Financial & admin"
 * roadmap item, US-path billing/RCM specifically (the India/NHCX path is a
 * separate, unbuilt item — §03.8/§13a). Same pattern as Scheduling.tsx and
 * BedBoard.tsx (read both first): direct `@medplum/core` CRUD against
 * standard FHIR resources, no new backend service, no parallel ledger
 * table. §13a calls this "the most Medplum-native subsystem of all six"
 * because every resource below (Account, Coverage, ChargeItem, Claim,
 * Invoice, PaymentReconciliation, Organization) is confirmed present in
 * `@medplum/fhirtypes` already — this is standard FHIR R4, not a
 * Medplum-specific extension.
 *
 * ── Data model ──────────────────────────────────────────────────────────
 * `Organization` (payer) --- `Coverage.payor[]` --- `Coverage` (one per
 * patient, this round) --- `Claim.insurance[].coverage`.
 * `Account` (one per patient, lazily created on first charge, checked for
 * an existing one first so this never duplicates) anchors `ChargeItem.
 * account[]` and `Invoice.account`.
 * `ChargeItem` (status 'billable' -> 'billed') is created from an existing
 * `Encounter` (reused, not a new kind of Encounter — see PatientDetail.tsx/
 * BedBoard.tsx for the two kinds already in this codebase). One or more
 * billable ChargeItems bundle into a `Claim` (status 'active'); creating
 * the Claim flips those ChargeItems to 'billed' — non-destructive, a
 * status transition like every other write in this codebase (Scheduling.
 * tsx's cancel, BedBoard.tsx's discharge), never a delete.
 * "Record payment" on a Claim creates an `Invoice` (status 'issued' then
 * 'balanced') and a `PaymentReconciliation` (status 'active', outcome
 * 'complete') — this models an already-collected/recorded payment, not a
 * live payment-gateway integration (no Stripe/processor credentials
 * exist in this environment either; stated here and in the UI).
 *
 * ── CRITICAL, READ BEFORE "IMPROVING" THIS FILE: no `ClaimResponse`,
 *    ever, this round ───────────────────────────────────────────────────
 * §13a's own research names the two real integration paths for actually
 * submitting a claim to a payer: Stedi (X12 837P submission, 277CA/835
 * responses) and Candid Health (fuller RCM handoff). Neither has vendor
 * credentials in this environment. This file deliberately stops at
 * "Claim is ready to submit" and does NOT create a `ClaimResponse` —
 * adjudication (approved/denied amounts, remark codes) can only come from
 * a real payer or clearinghouse. A fabricated `ClaimResponse` would be a
 * worse bug than not having one: it would let this demo (or a future
 * session that forgets this comment) silently claim "the payer approved
 * $X" when no payer was ever contacted — the exact same "honest gap over
 * fake data" principle this codebase already applies to medication codes
 * (no invented RxNorm) and discharge dispositions (free text, no invented
 * terminology). The "Submit to payer" button below is permanently
 * disabled with an explanatory tooltip, not wired to anything, and the
 * banner above the Claims panel says so in the UI itself — not only in
 * this comment — because a demo of this feature could otherwise easily
 * misrepresent how much automation exists. If a future round adds real
 * Stedi/Candid credentials, that integration point is exactly where
 * `handleSubmitToPayer` (currently not defined at all) would go, and
 * THAT is also where a real `ClaimResponse` would first appear, written
 * by parsing an actual 277CA/835, never synthesized client-side.
 *
 * ── Pricing simplification, stated plainly ─────────────────────────────
 * There is no fee schedule / `ChargeItemDefinition` lookup wired up (one
 * exists as a FHIR type but nothing populates or queries it here) — the
 * clinician enters `priceOverride` by hand per the FHIR field's own
 * purpose ("total price... overriding the list price associated with the
 * code"). `quantity` is descriptive only (e.g. "3" for "3 nights"); no
 * unit-price x quantity arithmetic is performed anywhere in this file —
 * `priceOverride` is always treated as the already-computed total for
 * that line, carried through unchanged into the Claim's `item.unitPrice`
 * AND `item.net` for that line (same value in both, since there is no
 * separate unit price to show). Same honest-text-over-fake-code
 * convention already used for medications and discharge dispositions:
 * `ChargeItem.code`/`Claim.item.productOrService` are free-text
 * `CodeableConcept.text` only — no fabricated CPT/HCPCS code, because
 * this codebase has no licensed fee-schedule terminology integrated.
 *
 * ── Coverage gating ─────────────────────────────────────────────────────
 * Creating a Claim is blocked, with a clear on-screen message (not a
 * silent no-op and not a generic error), unless the patient has at least
 * one `Coverage` with `status: 'active'` on file. Re-checked fresh right
 * before the write (same "recheck right before the write" discipline
 * BedBoard.tsx uses for bed occupancy), not trusted from a page-load
 * snapshot that could be stale.
 *
 * ── UI placement decision ───────────────────────────────────────────────
 * Reachable BOTH ways, like Scheduling.tsx: a top-level "Billing" nav
 * button (ClinicianApp.tsx) for billing-office-style work where staff
 * start from a patient search, AND a deep link from PatientDetail.tsx
 * (`navigate(/billing?patientId=...)`, same pattern as its existing "Book
 * appointment" button) for the much more common case of billing for the
 * patient already open. A case could be made for deep-link-only (billing
 * is almost always done in the context of one patient's chart, unlike
 * Beds which is a hospital-wide census with no natural single-patient
 * entry point) — reusing Scheduling.tsx's own precedent (also
 * fundamentally per-patient, also given a top-level nav button) was
 * chosen for UI consistency across this app's two patient-scoped-action
 * pages, not because Billing is expected to be used un-scoped as often as
 * Beds is.
 *
 * ── Scope ────────────────────────────────────────────────────────────────
 * Clinician-facing only, no patient-portal work this round (a patient has
 * no action to take here — viewing their own bill/pay online is a
 * reasonable future item, deliberately out of scope now, same kind of
 * explicit scoping note BedBoard.tsx makes for its own patient-portal
 * exclusion). No new RBAC: any signed-in Practitioner can do every action
 * on this page, same precedent as Scheduling.tsx and BedBoard.tsx.
 * India-path billing (NHCX, ExplanationOfBenefit) is a separate, unbuilt
 * roadmap item (§13a) — nothing here is India-specific despite the payer
 * seed data including one India-domiciled payer name for realism under
 * this platform's dual-jurisdiction framing.
 */

const ORG_TYPE_SYSTEM = 'http://terminology.hl7.org/CodeSystem/organization-type';
const CLAIM_TYPE_PROFESSIONAL = { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/claim-type', code: 'professional', display: 'Professional' }] };
const CLAIM_PRIORITY_NORMAL = { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/processpriority', code: 'normal', display: 'Normal' }] };

const CHARGE_STATUS_COLOR: Record<string, string> = {
  billable: 'blue',
  billed: 'teal',
  'not-billable': 'gray',
  aborted: 'red',
};

const CLAIM_STATUS_COLOR: Record<string, string> = {
  active: 'blue',
  cancelled: 'red',
  draft: 'gray',
};

const INVOICE_STATUS_COLOR: Record<string, string> = {
  issued: 'yellow',
  balanced: 'green',
  cancelled: 'red',
  draft: 'gray',
};

function money(m: Money | undefined): string {
  if (!m || m.value === undefined) return '—';
  const currency = m.currency ?? 'USD';
  return `${currency} ${m.value.toFixed(2)}`;
}

function chargeItemLabel(ci: ChargeItem): string {
  return ci.code?.text ?? '(no description)';
}

/** Finds the patient's Account, creating one lazily (and only once --
 * checked first) on first charge. See this file's header for why this is
 * lazy rather than created alongside the patient or the Coverage. */
async function getOrCreateAccount(medplum: ReturnType<typeof useMedplum>, patientId: string): Promise<Account> {
  const existing = await medplum.searchResources('Account', { subject: `Patient/${patientId}`, _count: 5 });
  const active = existing.find((a) => a.status === 'active');
  if (active) return active;
  return medplum.createResource<Account>({
    resourceType: 'Account',
    status: 'active',
    subject: [{ reference: `Patient/${patientId}` }],
    type: { text: 'patient' },
  });
}

/** The real, fresh gating check -- see this file's header ("Coverage
 * gating"). Never trust a page-load snapshot for this; call again
 * immediately before creating a Claim. */
async function findActiveCoverage(medplum: ReturnType<typeof useMedplum>, patientId: string): Promise<Coverage | undefined> {
  const coverages = await medplum.searchResources('Coverage', { beneficiary: `Patient/${patientId}`, _count: 10 });
  return coverages.find((c) => c.status === 'active');
}

export function Billing() {
  const medplum = useMedplum();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const preselectedPatientId = searchParams.get('patientId') ?? undefined;

  const [patient, setPatient] = useState<Patient | undefined>();
  const [patientQuery, setPatientQuery] = useState('');
  const [patientResults, setPatientResults] = useState<Patient[] | undefined>();

  useEffect(() => {
    if (preselectedPatientId) {
      medplum.readResource('Patient', preselectedPatientId).then(setPatient);
    }
  }, [medplum, preselectedPatientId]);

  useEffect(() => {
    if (patient || !patientQuery.trim()) {
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
  }, [medplum, patientQuery, patient]);

  return (
    <Stack maw={1000}>
      <Title order={3}>Billing &amp; RCM</Title>
      <Text size="sm" c="dimmed">
        US-path billing/RCM, built directly against FHIR Coverage/ChargeItem/Claim/Invoice/
        PaymentReconciliation — see this file&apos;s header comment for the full design and, especially,
        why there is no real payer submission yet.
      </Text>

      {!patient ? (
        <Paper withBorder p="md">
          <Stack gap="sm">
            <Title order={5}>Find a patient</Title>
            <TextInput
              label="Patient"
              placeholder="Search by name…"
              value={patientQuery}
              onChange={(e) => setPatientQuery(e.currentTarget.value)}
              w={320}
            />
            {patientResults !== undefined && (
              <Paper withBorder p="xs" w={320}>
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
                          setPatient(p);
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
        </Paper>
      ) : (
        <BillingWorkspace
          patient={patient}
          onChangePatient={() => {
            setPatient(undefined);
            navigate('/billing');
          }}
        />
      )}
    </Stack>
  );
}

function BillingWorkspace({ patient, onChangePatient }: { patient: Patient; onChangePatient: () => void }) {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const patientId = patient.id as string;

  const [coverage, setCoverage] = useState<Coverage | undefined>();
  const [coverageLoaded, setCoverageLoaded] = useState(false);
  const [payers, setPayers] = useState<Organization[] | undefined>();
  const [chargeItems, setChargeItems] = useState<ChargeItem[] | undefined>();
  const [encounters, setEncounters] = useState<Encounter[] | undefined>();
  const [claims, setClaims] = useState<Claim[] | undefined>();

  const reload = useCallback(() => {
    findActiveCoverage(medplum, patientId).then((c) => {
      setCoverage(c);
      setCoverageLoaded(true);
    });
    medplum.searchResources('ChargeItem', { subject: `Patient/${patientId}`, _sort: '-_lastUpdated', _count: 50 }).then(setChargeItems);
    medplum.searchResources('Claim', { patient: `Patient/${patientId}`, _sort: '-_lastUpdated', _count: 50 }).then(setClaims);
    medplum.searchResources('Encounter', { subject: `Patient/${patientId}`, _sort: '-date', _count: 50 }).then(setEncounters);
  }, [medplum, patientId]);

  useEffect(reload, [reload]);
  useEffect(() => {
    medplum
      .searchResources('Organization', { type: `${ORG_TYPE_SYSTEM}|ins`, _count: 50 })
      .then(setPayers);
  }, [medplum]);

  const [addCoverageOpen, setAddCoverageOpen] = useState(false);
  const [addChargeOpen, setAddChargeOpen] = useState(false);
  const [createClaimOpen, setCreateClaimOpen] = useState(false);
  const [paymentClaim, setPaymentClaim] = useState<Claim | undefined>();

  const billableCharges = (chargeItems ?? []).filter((c) => c.status === 'billable');

  return (
    <Stack gap="lg">
      <Group justify="space-between">
        <Text>
          Patient:{' '}
          <Text span fw={600}>
            {formatHumanName(patient.name)}
          </Text>{' '}
          <Text span c="dimmed" size="sm">
            (MRN {formatPatientMrn(patient)})
          </Text>
        </Text>
        <Button size="xs" variant="subtle" onClick={onChangePatient}>
          Change patient
        </Button>
      </Group>

      <Alert color="yellow" title="No real clearinghouse integration yet" variant="light">
        Claims built here stop at &quot;ready to submit.&quot; There is no Stedi or Candid Health
        connection in this environment (§13a), so nothing below ever contacts a real payer, and no
        <code> ClaimResponse</code> (payer adjudication) is ever created or simulated. The
        &quot;Submit to payer&quot; button in the claims panel is permanently disabled for this reason —
        see its tooltip.
      </Alert>

      {/* ── Coverage panel ──────────────────────────────────────────── */}
      <Paper withBorder p="md">
        <Group justify="space-between" mb="sm">
          <Title order={5}>Coverage</Title>
          {coverageLoaded && (
            <Button size="xs" variant="light" onClick={() => setAddCoverageOpen(true)}>
              {coverage ? 'Add another coverage' : 'Add coverage'}
            </Button>
          )}
        </Group>
        {!coverageLoaded ? (
          <Loader size="sm" />
        ) : coverage ? (
          <Group gap="xl">
            <Text size="sm">
              Payer:{' '}
              <Text span fw={600}>
                {coverage.payor?.[0]?.display ?? coverage.payor?.[0]?.reference ?? '—'}
              </Text>
            </Text>
            <Text size="sm">
              Member/policy id: <Text span fw={600}>{coverage.subscriberId ?? coverage.identifier?.[0]?.value ?? '—'}</Text>
            </Text>
            <Badge color="green" variant="light">
              {coverage.status}
            </Badge>
          </Group>
        ) : (
          <Text c="dimmed" size="sm">
            No active coverage on file. A Claim cannot be created until one is added.
          </Text>
        )}
      </Paper>

      {/* ── Charges panel ───────────────────────────────────────────── */}
      <Paper withBorder p="md">
        <Group justify="space-between" mb="sm">
          <Title order={5}>Charges</Title>
          <Button size="xs" variant="light" onClick={() => setAddChargeOpen(true)}>
            Add charge
          </Button>
        </Group>
        {chargeItems === undefined ? (
          <Loader size="sm" />
        ) : chargeItems.length === 0 ? (
          <Text c="dimmed" size="sm">
            No charges yet.
          </Text>
        ) : (
          <Table highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Description</Table.Th>
                <Table.Th>Qty</Table.Th>
                <Table.Th>Amount</Table.Th>
                <Table.Th>Status</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {chargeItems.map((ci) => (
                <Table.Tr key={ci.id}>
                  <Table.Td>{chargeItemLabel(ci)}</Table.Td>
                  <Table.Td>{ci.quantity?.value ?? 1}</Table.Td>
                  <Table.Td>{money(ci.priceOverride)}</Table.Td>
                  <Table.Td>
                    <Badge size="sm" color={CHARGE_STATUS_COLOR[ci.status] ?? 'gray'} variant="light">
                      {ci.status}
                    </Badge>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
        <Group justify="flex-end" mt="sm">
          <Button size="xs" disabled={billableCharges.length === 0} onClick={() => setCreateClaimOpen(true)}>
            Create claim from billable charges
          </Button>
        </Group>
      </Paper>

      {/* ── Claims panel ────────────────────────────────────────────── */}
      <Paper withBorder p="md">
        <Title order={5} mb="sm">
          Claims
        </Title>
        {claims === undefined ? (
          <Loader size="sm" />
        ) : claims.length === 0 ? (
          <Text c="dimmed" size="sm">
            No claims yet.
          </Text>
        ) : (
          <Table highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Created</Table.Th>
                <Table.Th>Items</Table.Th>
                <Table.Th>Total</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {claims.map((claim) => (
                <Table.Tr key={claim.id}>
                  <Table.Td>{claim.created?.slice(0, 10) ?? '—'}</Table.Td>
                  <Table.Td>{claim.item?.length ?? 0}</Table.Td>
                  <Table.Td>{money(claim.total)}</Table.Td>
                  <Table.Td>
                    <Badge size="sm" color={CLAIM_STATUS_COLOR[claim.status] ?? 'gray'} variant="light">
                      {claim.status}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Group gap="xs" justify="flex-end">
                      <Tooltip
                        label="Stubbed on purpose -- no Stedi/Candid Health (or any) clearinghouse credentials exist in this environment. Wiring this up means calling a real payer, not simulating one. See this file's header comment."
                        multiline
                        w={280}
                      >
                        <Button size="xs" variant="default" disabled>
                          Submit to payer
                        </Button>
                      </Tooltip>
                      <Button size="xs" variant="light" onClick={() => setPaymentClaim(claim)}>
                        Record payment
                      </Button>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Paper>

      <Modal opened={addCoverageOpen} onClose={() => setAddCoverageOpen(false)} title="Add coverage">
        <AddCoverageForm
          patientId={patientId}
          payers={payers}
          onDone={() => {
            setAddCoverageOpen(false);
            reload();
          }}
          onCancel={() => setAddCoverageOpen(false)}
        />
      </Modal>

      <Modal opened={addChargeOpen} onClose={() => setAddChargeOpen(false)} title="Add charge">
        <AddChargeForm
          patientId={patientId}
          encounters={encounters}
          onDone={() => {
            setAddChargeOpen(false);
            reload();
          }}
          onCancel={() => setAddChargeOpen(false)}
        />
      </Modal>

      <Modal opened={createClaimOpen} onClose={() => setCreateClaimOpen(false)} title="Create claim" size="lg">
        <CreateClaimForm
          patient={patient}
          practitionerId={profile?.resourceType === 'Practitioner' ? profile.id : undefined}
          billableCharges={billableCharges}
          onDone={() => {
            setCreateClaimOpen(false);
            reload();
          }}
          onCancel={() => setCreateClaimOpen(false)}
        />
      </Modal>

      <Modal opened={Boolean(paymentClaim)} onClose={() => setPaymentClaim(undefined)} title="Record payment">
        {paymentClaim && (
          <RecordPaymentForm
            patient={patient}
            claim={paymentClaim}
            onDone={() => {
              setPaymentClaim(undefined);
              reload();
            }}
            onCancel={() => setPaymentClaim(undefined)}
          />
        )}
      </Modal>
    </Stack>
  );
}

function AddCoverageForm({
  patientId,
  payers,
  onDone,
  onCancel,
}: {
  patientId: string;
  payers: Organization[] | undefined;
  onDone: () => void;
  onCancel: () => void;
}) {
  const medplum = useMedplum();
  const [payerId, setPayerId] = useState<string | undefined>();
  const [memberId, setMemberId] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    if (!payerId || !memberId.trim()) return;
    setSaving(true);
    try {
      const payer = payers?.find((p) => p.id === payerId);
      await medplum.createResource<Coverage>({
        resourceType: 'Coverage',
        status: 'active',
        beneficiary: { reference: `Patient/${patientId}` },
        payor: [{ reference: `Organization/${payerId}`, display: payer?.name }],
        subscriberId: memberId.trim(),
      });
      notifications.show({ message: 'Coverage added', color: 'green' });
      onDone();
    } catch (err) {
      notifications.show({ message: String(err), color: 'red' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Stack gap="sm">
      <Select
        label="Payer"
        placeholder={payers === undefined ? 'Loading…' : payers.length === 0 ? 'No payers seeded' : 'Select payer'}
        data={(payers ?? []).filter((p) => p.id).map((p) => ({ value: p.id as string, label: p.name ?? p.id ?? '' }))}
        value={payerId}
        onChange={(v) => setPayerId(v ?? undefined)}
        searchable
      />
      {payers?.length === 0 && (
        <Text size="xs" c="dimmed">
          Run <code>node scripts/seed/seed-payers.mjs</code> against this Medplum instance first.
        </Text>
      )}
      <TextInput
        label="Policy / member id"
        placeholder="Free text -- no real payer eligibility lookup exists (§13a)"
        value={memberId}
        onChange={(e) => setMemberId(e.currentTarget.value)}
      />
      <Group justify="flex-end">
        <Button variant="subtle" onClick={onCancel}>
          Cancel
        </Button>
        <Button loading={saving} disabled={!payerId || !memberId.trim()} onClick={handleSave}>
          Add coverage
        </Button>
      </Group>
    </Stack>
  );
}

function AddChargeForm({
  patientId,
  encounters,
  onDone,
  onCancel,
}: {
  patientId: string;
  encounters: Encounter[] | undefined;
  onDone: () => void;
  onCancel: () => void;
}) {
  const medplum = useMedplum();
  const [description, setDescription] = useState('');
  const [encounterId, setEncounterId] = useState<string | undefined>();
  const [quantity, setQuantity] = useState<number | string>(1);
  const [amount, setAmount] = useState<number | string>('');
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    if (!description.trim() || !encounterId || amount === '' || Number(amount) <= 0) return;
    setSaving(true);
    try {
      // Lazy Account creation -- see this file's header comment and
      // getOrCreateAccount()'s own doc comment for why this happens here
      // (first charge) rather than at patient registration or Coverage time.
      const account = await getOrCreateAccount(medplum, patientId);
      await medplum.createResource<ChargeItem>({
        resourceType: 'ChargeItem',
        status: 'billable',
        subject: { reference: `Patient/${patientId}` },
        context: { reference: `Encounter/${encounterId}` },
        code: { text: description.trim() },
        quantity: { value: Number(quantity) || 1 },
        // priceOverride is the already-computed TOTAL for this line -- see
        // header comment "Pricing simplification". There is no fee
        // schedule / ChargeItemDefinition lookup here.
        priceOverride: { value: Number(amount), currency: 'USD' },
        account: [{ reference: `Account/${account.id}` }],
      });
      notifications.show({ message: 'Charge added', color: 'green' });
      onDone();
    } catch (err) {
      notifications.show({ message: String(err), color: 'red' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Stack gap="sm">
      <TextInput
        label="Description"
        placeholder='Free text -- e.g. "OPD consultation", "Lab panel", "Ward stay, 3 nights" (no CPT/HCPCS code: none is wired up)'
        value={description}
        onChange={(e) => setDescription(e.currentTarget.value)}
      />
      <Select
        label="Encounter"
        placeholder={
          encounters === undefined ? 'Loading…' : encounters.length === 0 ? 'No encounters on file for this patient' : 'Select encounter'
        }
        data={(encounters ?? [])
          .filter((e) => e.id)
          .map((e) => ({
            value: e.id as string,
            label: `${e.period?.start?.slice(0, 10) ?? '—'} · ${e.class?.display ?? e.class?.code ?? 'encounter'} (${e.status})`,
          }))}
        value={encounterId}
        onChange={(v) => setEncounterId(v ?? undefined)}
        searchable
      />
      <Group>
        <NumberInput label="Quantity" value={quantity} onChange={setQuantity} min={1} w={120} />
        <NumberInput
          label="Amount (USD)"
          placeholder="Manually entered -- no fee schedule"
          value={amount}
          onChange={setAmount}
          min={0.01}
          decimalScale={2}
          w={200}
        />
      </Group>
      <Group justify="flex-end">
        <Button variant="subtle" onClick={onCancel}>
          Cancel
        </Button>
        <Button loading={saving} disabled={!description.trim() || !encounterId || amount === ''} onClick={handleSave}>
          Add charge
        </Button>
      </Group>
    </Stack>
  );
}

function CreateClaimForm({
  patient,
  practitionerId,
  billableCharges,
  onDone,
  onCancel,
}: {
  patient: Patient;
  practitionerId: string | undefined;
  billableCharges: ChargeItem[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const medplum = useMedplum();
  const patientId = patient.id as string;
  const [selected, setSelected] = useState<Set<string>>(new Set(billableCharges.map((c) => c.id as string)));
  const [saving, setSaving] = useState(false);
  const [blockedMessage, setBlockedMessage] = useState<string | undefined>();

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const selectedItems = billableCharges.filter((c) => c.id && selected.has(c.id));
  const total = selectedItems.reduce((sum, c) => sum + (c.priceOverride?.value ?? 0), 0);

  async function handleCreate() {
    if (selectedItems.length === 0 || !practitionerId) return;
    setSaving(true);
    setBlockedMessage(undefined);
    try {
      // The real gate -- re-checked fresh right now, not from whatever the
      // page loaded with. See this file's header ("Coverage gating").
      const coverage = await findActiveCoverage(medplum, patientId);
      if (!coverage?.id) {
        setBlockedMessage(
          'This patient has no active Coverage on file. Add a Coverage first (Coverage panel) before creating a claim.'
        );
        return;
      }

      const now = new Date().toISOString();
      const items = selectedItems.map((ci, idx) => ({
        sequence: idx + 1,
        productOrService: { text: chargeItemLabel(ci) },
        encounter: ci.context?.reference ? [{ reference: ci.context.reference }] : undefined,
        quantity: ci.quantity,
        // unitPrice === net: priceOverride is already the line total, no
        // unit x quantity math -- see header "Pricing simplification".
        unitPrice: ci.priceOverride,
        net: ci.priceOverride,
      }));

      const claim = await medplum.createResource<Claim>({
        resourceType: 'Claim',
        status: 'active',
        type: CLAIM_TYPE_PROFESSIONAL,
        use: 'claim',
        patient: { reference: `Patient/${patientId}` },
        created: now,
        provider: { reference: `Practitioner/${practitionerId}` },
        priority: CLAIM_PRIORITY_NORMAL,
        insurance: [{ sequence: 1, focal: true, coverage: { reference: `Coverage/${coverage.id}` } }],
        item: items,
        total: { value: total, currency: 'USD' },
      });

      // Non-destructive: flip status billable -> billed, never delete.
      await Promise.all(
        selectedItems.map((ci) => medplum.updateResource<ChargeItem>({ ...ci, status: 'billed' }))
      );

      notifications.show({ message: `Claim created (Claim/${claim.id}), ${selectedItems.length} charge(s) marked billed`, color: 'green' });
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
        Patient: <Text span fw={600}>{formatHumanName(patient.name)}</Text>
      </Text>
      <Stack gap={4}>
        {billableCharges.map((ci) => (
          <Checkbox
            key={ci.id}
            label={`${chargeItemLabel(ci)} — ${money(ci.priceOverride)}`}
            checked={Boolean(ci.id && selected.has(ci.id))}
            onChange={() => ci.id && toggle(ci.id)}
          />
        ))}
      </Stack>
      <Divider />
      <Text size="sm">
        Total: <Text span fw={600}>USD {total.toFixed(2)}</Text>
      </Text>
      {blockedMessage && (
        <Alert color="red" title="Cannot create claim">
          {blockedMessage}
        </Alert>
      )}
      <Group justify="flex-end">
        <Button variant="subtle" onClick={onCancel}>
          Cancel
        </Button>
        <Button loading={saving} disabled={selectedItems.length === 0} onClick={handleCreate}>
          Create claim
        </Button>
      </Group>
    </Stack>
  );
}

function RecordPaymentForm({
  patient,
  claim,
  onDone,
  onCancel,
}: {
  patient: Patient;
  claim: Claim;
  onDone: () => void;
  onCancel: () => void;
}) {
  const medplum = useMedplum();
  const patientId = patient.id as string;
  const [amount, setAmount] = useState<number | string>(claim.total?.value ?? '');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleRecord() {
    if (amount === '' || Number(amount) <= 0 || !claim.id) return;
    setSaving(true);
    try {
      const account = await getOrCreateAccount(medplum, patientId);
      const now = new Date().toISOString();

      const invoice = await medplum.createResource<Invoice>({
        resourceType: 'Invoice',
        status: 'issued',
        subject: { reference: `Patient/${patientId}` },
        account: { reference: `Account/${account.id}` },
        date: now,
        lineItem: (claim.item ?? []).map((item, idx) => ({
          sequence: idx + 1,
          // Claim items don't carry the ChargeItem id, only its free-text
          // productOrService -- see this file's header. A tighter design
          // would thread the ChargeItem reference through the Claim item
          // too; left as-is this round since the Claim total is already
          // the authoritative amount being invoiced.
          chargeItemCodeableConcept: item.productOrService,
        })),
        totalNet: claim.total,
      });

      // This models an ALREADY-COLLECTED/recorded payment (patient paid
      // out of pocket, or a manually-recorded payer remittance) -- not a
      // live payment-gateway integration. See this file's header.
      //
      // paymentDate is FHIR type `date` (calendar date only), NOT
      // `dateTime` -- confirmed live against this Medplum instance, which
      // 400s a full ISO timestamp there with "Invalid date format"
      // (`created` just above it IS `dateTime` and accepts the full
      // timestamp fine; don't "fix" these to match each other).
      await medplum.createResource({
        resourceType: 'PaymentReconciliation',
        status: 'active',
        outcome: 'complete',
        created: now,
        paymentDate: now.slice(0, 10),
        paymentAmount: { value: Number(amount), currency: 'USD' },
        paymentIdentifier: note.trim() ? { value: note.trim() } : undefined,
      });

      await medplum.updateResource<Invoice>({ ...invoice, status: 'balanced' });

      notifications.show({ message: `Payment recorded, Invoice/${invoice.id} balanced`, color: 'green' });
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
        Claim total: <Text span fw={600}>{money(claim.total)}</Text>
      </Text>
      <NumberInput label="Payment amount (USD)" value={amount} onChange={setAmount} min={0.01} decimalScale={2} />
      <TextInput
        label="Payment method / reference (optional)"
        placeholder='e.g. "Cash", "Card ****1234", "Remittance ref ABC123" -- free text, no payment gateway'
        value={note}
        onChange={(e) => setNote(e.currentTarget.value)}
      />
      <Text size="xs" c="dimmed">
        Records an already-collected payment (cash/card at the desk, or a manually-entered payer
        remittance). There is no live payment-gateway integration in this environment.
      </Text>
      <Group justify="flex-end">
        <Button variant="subtle" onClick={onCancel}>
          Cancel
        </Button>
        <Button loading={saving} disabled={amount === ''} onClick={handleRecord}>
          Record payment
        </Button>
      </Group>
    </Stack>
  );
}
