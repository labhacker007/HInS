# HInS Platform Blueprint

**Project Development & Requirements Document · v1.0**
Status: Draft — decisions in progress · Scope: India + US, dual-jurisdiction · Last updated: 2026-10-19

A modular, API-first, AI-native hospital operating system — architecture, compliance
framework, licensing strategy, and roadmap for a multi-specialty deployment spanning
India and the United States.

**This is the source of truth.** It's revised each time the platform plan is
discussed, and a rendered, designed version is kept in sync as a published
Claude artifact: https://claude.ai/artifact/3NRZUR3SC5GoVQi3K1jWSw

> **Assumption, flag if wrong:** the original brief listed "SNOMAN" alongside DPDP,
> HIPAA, and ICMR. This reads as **SNOMED CT** — the one term in that set that's a
> coding standard rather than a law or ethics body (§03.6).

---

## Decisions log

| Date | Decision | Rationale |
|---|---|---|
| 2026-10-15 | EMR/EHR core: **Medplum** (Apache-2.0) | The only §07 candidate that's both permissively licensed enough to fork and a complete platform — FHIR server, React UI kit, OAuth2/SMART auth, Access Policies, and **Bots** (serverless hooks on FHIR events). Bots are the attachment point for consent gating and the voice-to-text pipeline (§08.2). |
| 2026-10-15 | Backend runtime: **Node.js 22 LTS** (not Bun or Deno) | Matches Medplum's own runtime (Bots execute in a Node VM-context). 2026 comparisons converge on Node as the lowest-risk production default once a real DB and validation layer are in the loop — Bun's and Deno's raw-throughput edge mostly disappears, and Node has the deepest APM/observability support, which matters more than micro-benchmarks for an auditable system. |
| 2026-10-15 | Backend framework: **Fastify 5** + Zod validation (`fastify-type-provider-zod`), for every custom HInS service | Schema-first by default — every route's request/response shape is a Zod schema, which both validates at runtime and can generate the service's OpenAPI doc. Chosen over Hono (built for edge/multi-runtime deployment, which this self-hosted, jurisdiction-pinned platform doesn't need) and bare Express (weaker TypeScript inference, maintenance-mode). Replaces the Phase 00 `node:http` stubs in consent-service and terminology-service. |
| 2026-10-15 | ORM: **Drizzle ORM** (not Prisma) | SQL-fluent, infers types straight from the schema with no codegen step, ~10-20ms cold start vs. Prisma 7's ~90ms. Prisma's extra abstraction buys little here since the team is comfortable writing SQL and the schemas (append-only consent ledger, terminology lookups) are simple relational shapes, not deep object graphs. |
| 2026-10-15 | Database: **two Postgres instances, not one shared one** — Medplum keeps its own `postgres:16` (vendor-tested, untouched); HInS's own services (consent-service, terminology-service, future custom services) get a dedicated `pgvector/pgvector:pg18` instance | Keeps our schema migrations from ever touching Medplum's internal one, and gets our own services current Postgres (18: async I/O, built-in `uuidv7()` — used as the primary key default on the consent ledger so audit rows sort by creation order for free) plus pgvector built in, for the embeddings/RAG work in §08 (CDSS groundedness checks, semantic search). Verified locally: pgvector 0.8.7 on Postgres 18.6, `uuidv7()` confirmed callable. |
| 2026-10-15 | Frontend: **React 18/19 + Vite + Mantine**, via `@medplum/react` | Not a free choice once Medplum (above) is the core — `@medplum/react`'s peer deps pin React 18/19 and it's built on Mantine. Building a custom clinical UI kit from scratch to use a different frontend framework would mean re-implementing exactly what Medplum already gives away under Apache-2.0, directly against the brief's own "don't reinvent the wheel" instruction. Vite over Next.js: this is an authenticated SPA behind the API gateway, not a public site — no SSR benefit, and Vite keeps the self-hosted deployment simpler. |
| 2026-10-15 | Terminology Service: plan to front a **HAPI FHIR** (Apache-2.0) terminology server rather than hand-rolling SNOMED CT/LOINC/ICD graph logic | HAPI FHIR ships `$lookup`/`$validate-code`/`$expand` out of the box — reusing it here is the same "don't reinvent the wheel" call as Medplum, just for terminology instead of the clinical datastore. Not wired up yet: needs the actual licensed SNOMED CT India edition loaded (§03.5), which isn't available in this environment. The service stays a Fastify stub until then. |

**Build vs. buy, stated plainly for this round:** the EMR/EHR core, the frontend UI kit, the backend web framework, the ORM, and the terminology engine are all cases where an existing permissively-licensed project does the job — building any of them from scratch would be re-solving a already-solved, non-differentiating problem. The one piece of this round that *is* built from scratch is the Consent Service's actual domain logic (the DPDP/ABDM/HIPAA/ICMR rules themselves, §04) — no open-source project implements that combination, and it's HInS's real differentiator.

| 2026-10-15 | **Phase 01 MVP built**: one Vite + React app (`apps/web`), role-split by FHIR profile type — clinician app (patient registration, encounter notes, prescriptions, consent recording) and patient portal (records view, consent grant/revoke) | Proves the confirmed stack end to end rather than leaving it as a plan. Clinician and patient flows verified in a real browser (Playwright): sign in → register patient → add note → prescribe → record consent (clinician side); sign in → view records → grant consent → revoke it (patient side). Zero console errors in either run. The HInS Dev Medplum project, its admin client application, and a test patient login were all created via Medplum's own API (`Project/$init`, project invite) rather than requiring manual browser signup. |

**Simplification carried into the MVP, not hidden:** both the clinician's "record consent" and the patient's "grant consent" actions write a consent grant directly, immediately. A real ABDM flow routes a data-sharing request through the patient's own consent-manager app for approval first (§04.2) — that approval round trip isn't built; see §16. The MVP's patient-side "revoke anytime" behavior (§04.5) is real and fully tested, independent of that gap.

| 2026-10-15 | **Demo data seeded with real coded clinical data** (`scripts/seed/`): six patients across departments, a second clinician login, `Condition` resources coded with SNOMED CT + ICD-10, lab `Observation`s coded with LOINC + UCUM units, and a standing `treatment_authorization` consent on file for every patient | Makes §03.6's "coded, not free-text, wherever a terminology exists" principle visible and testable rather than only written down. Codes used are well-known, publicly documented ones (the same used throughout HL7's own FHIR spec examples) — **this is not the same as a licensed terminology server being integrated**; §03.5/§03.6's SNOMED CT India affiliate license and HAPI FHIR terminology server are still open, unbuilt items. Medications stay text-only on purpose: no drug terminology (RxNorm/India Drug Extension) is integrated, and a fabricated code would be a worse bug than none. Full detail, including what "every patient has a consent on file" does and doesn't mean for DPDP/HIPAA compliance, is in `scripts/seed/README.md` — read it before citing this seed data as evidence of compliance. |

| 2026-10-15 | **De-identification / data exposure service built** (`services/deid-service`, blueprint §11) — 3 distinct, named methods: `safe_harbor` (HIPAA Safe Harbor, irreversible, generalized dates), `limited_dataset` (HIPAA Limited Data Set, irreversible, full dates/coarse geography), `pseudonymized` (GDPR Art. 4(5), reversible via a stored mapping, for admin/ops use) | `safe_harbor`+`purpose=research` is gated on an active research consent via the Consent Service — the two services now compose into a real control, not independent pieces. Every disclosure (not just the de-identified output) is audit-logged with the real patient IDs, matching HIPAA's accounting-of-disclosures and GDPR Art. 30 — see §15 risk register for why that audit table is itself sensitive. Verified end to end against real seeded patients: a patient without research consent is correctly skipped with a stated reason; `limited_dataset` correctly preserves full dates where `safe_harbor` doesn't (including the 90+ age-suppression rule); `reidentify` correctly recovers a `pseudonymized` pseudonym and correctly 404s on a `safe_harbor` one (proving real irreversibility, not just a label). Full scope of what this does and doesn't mean for compliance is in `services/deid-service/README.md`. |

| 2026-10-15 | **Note editing with full version history**, and a real attribution mechanism found for it | Checked directly against the running Medplum instance before building anything: `meta.author` is not auto-populated on writes, and a client-supplied `meta.author` is silently discarded (`meta` is server-controlled) — confirmed the same way that `_history` with `meta.versionId`/`lastUpdated` per version works correctly. Attribution instead lives in `DocumentReference.author`, a normal FHIR field that persists like any data and is preserved per-version in history. Every create/edit sets it to the signed-in practitioner. Built for notes only; `MedicationRequest` editing isn't wired up yet (§16). History is clinician-facing only, not shown in the patient portal — a UX choice, not a limit. |
| 2026-10-15 | **Voice dictation added, explicitly dev/demo only** | Uses the browser's native `SpeechRecognition` API — in Chrome, that sends audio to Google's cloud speech service, directly contradicting §08's self-hosted-by-default design. No self-hosted Whisper is running in this environment; this is what's real and demonstrable today, labeled as such in the UI next to the button, not quietly shipped as if compliant. What *is* built faithfully to §08.1: no microphone access without a logged `recording`-type consent first (auto-created via the Consent Service if none is active) — a verbal-confirmation simplification, not a captured e-signature, same as every other documented simplification in this codebase. |

| 2026-10-18 | **deid-service + audit-service RBAC hardening**: `GET /audit` (deid-service), `GET`/`POST /subscriptions` and `GET /notifications` (audit-service) are no longer unauthenticated | Researched against the live Medplum instance before implementing (not guessed): `GET /oauth2/userinfo` only returns the User id, not the Practitioner id this needed; forwarding the caller's own token to `GET /fhir/R4/Practitioner/{claimedId}` and checking it returns 200 was tried and found **insecure** on this instance — this project's default Practitioner Access Policy lets any authenticated practitioner read any *other* Practitioner record too, so a claimed id isn't provable that way (verified: Dr. Sharma's real token successfully read Medplum Admin's Practitioner record). What works and isn't spoofable: Medplum's own `GET /auth/me`, which resolves the caller's Practitioner from the token's session server-side with no claimed id involved. Role check reuses `audit-service`'s existing `alert_subscriptions` table directly (role IN `tenant_admin`/`compliance_officer`) rather than a second role table. `GET /notifications` additionally checks the resolved caller's own id matches the requested `recipientId` unless they hold an admin role. Verified end-to-end with real tokens (admin@example.com and dr.sharma@stjones.example, who is seeded but deliberately not in `alert_subscriptions`): every gated endpoint correctly 401s with no token, 403s for Dr. Sharma, and 200s for admin. **Still open, stated in both services' READMEs and §16:** role source of truth is still the hand-seeded table, not real Keycloak RBAC; token validation is a live per-request call to Medplum, not local JWT verification. This hardening also broke `apps/web`'s notification bell (it polled `GET /notifications` with no Authorization header) — caught by an independent reviewer and tester before merge, fixed the same day by threading `useMedplum().getAccessToken()` through `auditApi.ts`'s request helper; re-verified live with a real token (401 with none, 200 with one). |
| 2026-10-18 | **Consent approval round trip built** (`services/consent-service`, closes the §16 gap this round): `POST /consents` takes an optional `requiresApproval` flag; when true the record lands as `status='pending'` instead of `granted`, and only `POST /consents/:id/approve` or `.../deny` (patient-initiated) can move it out of that state | The one documented exception to the ledger's append-only design (schema.ts's header): a `pending` row is UPDATEd in place on approve/deny rather than inserted as a new row, because a pending request was never an effective grant — there's no history being overwritten. Denial reuses `status='revoked'` with a `statusNote` ("Denied by patient (never approved)") rather than adding a fifth enum value, distinguished from a real post-grant revoke by that note and by `validityStart` never having been set to an approval time. `apps/web`'s `MyConsents`/`ConsentHistoryList` show a "Pending approval" bucket with Approve/Deny actions (patient view only) alongside Active/Revoked/Expired. **Known gap, not hidden:** neither endpoint checks that the caller is actually the patient the pending request is for — anyone who knows a consent id can approve or deny it; real RBAC/ownership enforcement is still open (§16, same theme as the RBAC hardening above). |
| 2026-10-18 | **Appointment scheduling built** using FHIR's native `Appointment` resource directly via `@medplum/core`, no new backend service | Reuses Medplum rather than building a bespoke scheduling table — `status: 'booked'`/`'cancelled'` only, cancellation is non-destructive (status flip, never a delete). `apps/web` clinician view (`Scheduling.tsx`): patient + practitioner select, date/time/duration, free-text reason, upcoming-appointments table with Cancel. Patient view (`MyAppointments.tsx`): read-only list of their own upcoming appointments. Closes part of the §16 "Fully EHR/EMR" gap (scheduling specifically) — bed/ward management and full order workflows beyond notes/eRx remain unbuilt. **Known gap, not hidden:** no double-booking detection — two appointments for the same practitioner at overlapping times are both accepted silently. |
| 2026-10-18 | **Practitioner double-booking detection added** to `apps/web`'s `Scheduling.tsx` — `handleBook()` now blocks booking an `Appointment` that overlaps an existing non-cancelled one for the same practitioner | New pure, exported `appointmentsOverlap(existingStart, existingEnd, proposedStart, proposedEnd)` does the real check with half-open `[start, end)` semantics (back-to-back slots allowed), unit-tested standalone outside the browser (true-overlap, exactly-adjacent, identical-slot, contains-both-ways, no-overlap cases, all passing). Tested live against this Medplum instance first rather than assumed: the FHIR `date` search param *does* reliably narrow `Appointment` results to a day range (`ge`/`lt`), and `status:not=cancelled` works too — so `handleBook()` uses both as a coarse server-side narrowing filter (widened a day on each side to tolerate browser/server timezone mismatch at the day boundary), then runs `appointmentsOverlap()` client-side as the actual, precise arbiter — so a narrowing miss can only over-fetch, never hide a real conflict. On conflict, a Mantine notification names the clashing time and patient instead of a generic error, and the form is left as-is. Verified live end-to-end in a real browser (throwaway Playwright driver, `apps/web` on an alternate port): seeded a real overlapping `Appointment` for Dr. Sharma via direct FHIR calls, signed in as her, attempted to book over it — blocked with the expected conflict notification and no new resource created (confirmed via a follow-up FHIR query); a non-overlapping time for the same practitioner booked successfully. **Known gap, not hidden, scoped deliberately:** practitioner-conflict only — same-PATIENT double-booking (one patient booked into two overlapping slots with different practitioners) is still not checked; check-then-create is also not atomic (no backend service/DB constraint backs this browser-direct-to-FHIR flow), so two simultaneous bookings for the same overlapping slot could theoretically both pass the pre-check — a real, inherent limitation of this feature's architecture, not something this round fixed. |
| 2026-10-18 | **Consent approve/deny ownership check added** to `services/consent-service` — `POST /consents/:id/approve` and `.../deny` previously had no caller-identity check at all; anyone who knew a pending consent's id could approve or deny it | Adds a `resolveCaller()`-style check (via Medplum's `GET /auth/me`, generalized to accept both `Practitioner/` and `Patient/` profile prefixes) requiring the resolved caller to be the exact `Patient` the request is for — no admin/practitioner override, since only the patient is meant to decide. Gate runs after the pre-existing 404/409 checks, unchanged. Verified live: no token → 401, a real practitioner token → 403 naming the mismatch, the real patient's own token → 200 with the record actually transitioning. **Known gap, not hidden** (new `services/consent-service/README.md`): legal representative/guardian approval (`CreateConsentSchema`'s optional `grantor.representative` field) is not modeled — only the patient's own resolved identity is ever accepted. This closes the base ownership gap noted in the entry above; the representative sub-case remains open. |
| 2026-10-18 | **Notification read/read-all ownership check added** to `services/audit-service` — `POST /notifications/:id/read` and `/read-all` previously let any caller mark any notification read with no ownership check | Both routes now apply the exact same self-or-admin pattern `GET /notifications` already used: caller must be the notification's own recipient, or hold an active admin role, to mark it read. `:id/read` fetches the row first to learn its `recipientId` (404 before the auth gate if the id doesn't exist). Verified live with direct Postgres checks that the `read` flag actually flips, not just a 200 with no effect, including the admin-acting-on-someone-else's-notification path. |
| 2026-10-18 | **Role source of truth for `deid-service`/`audit-service` moved from the hand-seeded `alert_subscriptions` table to a real Keycloak realm** (`hins-dev`) — closes the biggest remaining item from the 2026-10-18 RBAC hardening entry above | `services/{deid,audit}-service/src/keycloakRoles.ts` looks up the caller's realm role (`tenant_admin`/`compliance_officer`) via Keycloak's own Admin REST API, authenticating as a real service-account `client_credentials` identity (not shared bootstrap admin credentials) — the exact Keycloak role set needed (`view-users`+`query-users`+`view-realm`+`manage-users` on `realm-management`, within `hins-dev`'s own self-management pattern) was found empirically against the live instance, not guessed. **Fails closed**: any Keycloak error (unreachable, timeout, malformed response) resolves to "no role" (403) — verified live by pointing a test instance's `KEYCLOAK_BASE_URL` at an unreachable port and confirming an otherwise-valid admin token still got 403, not 200 or 500. Medplum login and caller-identity resolution (`resolveCaller()` via `GET /auth/me`) are completely unchanged — this only moves *where an already-identified caller's role comes from*, not *how the caller is identified*. `audit-service`'s `POST`/`GET /subscriptions` were repointed at Keycloak for real rather than left silently writing to a now-unread table; `alert_subscriptions` the table is kept and still drives `POST /events`' notification fan-out, a separate concern confirmed untouched. Seeded by a new idempotent `scripts/seed/seed-keycloak-roles.mjs`. **Known gap, not hidden:** Medplum and Keycloak are *not federated* — there is no SSO, practitioners/patients still log into Medplum directly, and provisioning a practitioner into Keycloak is still a separate manual/seed step from their Medplum account existing. That reconciliation remains open (§16). |

| 2026-10-19 | **Deep research round on DPDP, HIPAA, medical-record standardization, and the team/expertise needed to build a fully-wired EHR/EMR/Hospital Management System** — user asked for real research before further building, not assumptions | Five parallel research agents (DPDP, HIPAA, standardization, team/expertise, HMS subsystem scope) plus a synthesis pass, all re-verified against live web sources as of this date, not carried forward from the earlier (thinner, partly-unconfirmed) §03 text. Substantially expanded/revised: §03.1/03.1a (DPDP — phased commencement ~May 2027, no health-data special category, SDF obligations, cross-border is a negative list with no restricted countries yet), §03.4/03.4a (HIPAA — NPRM now slipped to a July 2027 target and actively opposed; Section 1557 AI-bias duty already live since May 2025; two named Security/Privacy Officials already unconditionally required), §03.5–03.8 (new: SNOMED CT India licensing is free/administrative, not a blocker; India's real RxNorm-equivalent is CDCI; US Core 6.1.0/USCDI v3/SMART 2.2.0 baseline; the ABDM FHIR IG's seven Composition "Record" bundles are a literal unbuilt gap, not an aspirational one; NHCX), §04.1/§04.4 (ICMR consent sub-types; the guardian/representative gap is live today, not hypothetical, given St. Jones's pediatrics department), §08.4 (new — per-function AI Access Policy as the actual minimum-necessary control, the single highest-leverage finding of the round), §09.1 (new — FDA SaMD boundary, unconditional on image/signal analysis), §12a (new — required team/expertise, two tiers), §13/§13a (HMS subsystem build order: bed/ward first, then US billing/RCM, then pharmacy plumbing, then NHCX, then inventory, then LIS/RIS-PACS last behind the AGPL review). Every finding that couldn't be verified against a primary legal/technical source (a Gazette page date, an NPRM figure, a sublicense requirement) is flagged as such in the text, not smoothed over. This is research + planning only — no code changed in this round. |

| 2026-10-19 | **Bed/ward/inpatient admission management built** (`apps/web/src/pages/clinician/BedBoard.tsx`, new route `/beds`) — closes the §13/§13a "01a — Bed/ward management" roadmap item and part of §16's "Fully EHR/EMR" gap | FHIR-native, no new backend service, no parallel bed-status table: two-level `Location` hierarchy (ward `physicalType` `wa`, bed `physicalType` `bd`, via `partOf`), seeded by a new idempotent `scripts/seed/seed-beds.mjs` (2 wards x 4 beds). Admission is a single long-lived `Encounter` (`class: IMP` — the exact same coding `PatientDetail.tsx`'s note-taking "IPD" setting already uses, reused not reinvented; `status: 'in-progress'` for the whole stay) whose `location` array is a repeating, append-only history: admit pushes the first entry, transfer closes the current entry's `period.end` and pushes a new one, discharge closes the last entry and finishes the Encounter with `hospitalization.dischargeDisposition.text` (free-text only, deliberately — no discharge-disposition terminology is wired up anywhere in this codebase, same honest-text-over-fake-code call `scripts/seed/seed-demo-data.mjs` already documents for medications). **Explicitly NOT the same Encounter concept** as `PatientDetail.tsx`'s existing per-note `class: IMP` Encounter — that one is created `status: 'finished'` immediately as a one-shot wrapper around a single note and is untouched by this work; **known gap, stated plainly:** a real admission's IPD notes taken during the stay are not yet linked to this admission Encounter, left out of scope to avoid risking the existing, working note-taking feature. §13a's own note that "a `Location` on an `Appointment` doesn't reserve capacity" is addressed by NOT reusing `Appointment`/`Schedule` at all — occupancy is instead derived live from `Encounter`, checked directly against this running instance before relying on it: `GET /fhir/R4/Encounter?status=in-progress&location=Location/<bed>` confirmed to match "this bed appears anywhere in the list," including an OLD, closed location entry on a transferred-out encounter — not "is the currently-open one" — so `isBedCurrentlyOccupied()` additionally requires client-side that the matching Encounter's last (open, no `period.end`) location entry is actually that bed. Verified live end-to-end (real browser, throwaway Playwright driver, `apps/web` on an alternate port, signed in as `dr.sharma@stjones.example`): admitted Asha Verma into a free bed (confirmed via follow-up `GET /fhir/R4/Encounter` — real `in-progress` Encounter, correct open `location` entry, census shows her); confirmed the UI offers no Admit action on an occupied row and that the occupancy-check query correctly reports the bed occupied, with exactly one open location entry for it throughout (the adversarial "second patient into the same bed" case); transferred her to a different free bed (same Encounter id reused, old entry closed with `period.end`, new entry open, old bed free again in the census); discharged her (`status: 'finished'`, `dischargeDisposition` set, bed free again). All test admissions discharged — zero in-progress Encounters left behind. **Known limitation, stated plainly (a distinct gap from `Scheduling.tsx`'s own documented limitation, which is that same-patient double-booking across practitioners isn't checked — that file has no TOCTOU caveat):** the occupancy check-then-write is not atomic — two concurrent admit/transfer attempts into the same bed could theoretically both pass the check before either write lands, since this is a direct browser-to-FHIR flow with no backend service or DB constraint to lean on; a real fix needs a server-side conditional-update/transaction guarantee, out of scope this round. Discharge additionally re-fetches the Encounter immediately before writing (fixed post-review, 2026-10-19) so a concurrent double-discharge attempt fails cleanly instead of silently overwriting with a stale copy. Clinician-facing only this round — no patient-portal view of the bed census, stated as deliberately out of scope, not an oversight. No new RBAC: any signed-in Practitioner can admit/transfer/discharge, same as Scheduling.tsx's existing Appointment booking. |

| 2026-10-19 | **US-path billing/RCM built** (`apps/web/src/pages/clinician/Billing.tsx`, new route `/billing`, deep-linked from `PatientDetail.tsx`) — closes the §13/§13a "03 — Financial & admin" roadmap item's US path specifically; India/NHCX billing remains a separate, unbuilt item | FHIR-native, no new backend service: `Organization` (payer, seeded idempotently by new `scripts/seed/seed-payers.mjs` — Aetna, UnitedHealthcare; US-only this round, deliberately — an India payer was dropped post-review once it was noticed every money field here is hardcoded to `currency: 'USD'`, which would have silently mis-denominated anything billed against it) → `Coverage` (one per patient, `status: 'active'`, free-text member id — no real eligibility check) → `ChargeItem` (`status: 'billable'`, created from an existing `Encounter`, manually-entered `priceOverride` since no `ChargeItemDefinition`/fee-schedule is wired up — same honest-text-over-fake-code call already made for medications/discharge dispositions) → `Claim` (`status: 'active'`, bundles one or more billable ChargeItems against one Coverage; creating it non-destructively flips those ChargeItems to `billed`) → `Invoice` + `PaymentReconciliation` ("Record payment" creates both, flips the Invoice `issued` → `balanced`). `Account` is the ledger anchor, created lazily (checked-first, not duplicated) on a patient's first charge. **Deliberately, and stated in the UI itself (a yellow banner plus a permanently-disabled "Submit to payer" button with an explanatory tooltip), not just in a code comment: no `ClaimResponse` is ever created.** §13a's own research names Stedi (X12 837P/277CA/835) and Candid Health as the two real clearinghouse paths — neither has credentials in this environment, and a fabricated adjudication would be a worse bug than none (same principle already applied to medication/terminology codes). This round stops at "Claim is ready to submit" and "payment recorded," nothing further. Verified live by direct FHIR calls against the running Medplum instance mirroring `Billing.tsx`'s exact request shapes (a real-browser Playwright run was judged not practical in this round's time budget — Playwright/Chromium aren't installed and nothing was added to the repo to install them, per the "no new npm dependency" rule): added a Coverage for Asha Verma against Aetna; created a ChargeItem from one of her existing Encounters; created a Claim and confirmed via a fresh `GET` that it references the right Coverage/Encounter and that the ChargeItem flipped `billable`→`billed`; **the adversarial case that actually tests the gate** — confirmed a different seeded patient with no active Coverage on file correctly makes the exact gate function (`findActiveCoverage()`) return nothing, which is what blocks claim creation in the UI with an on-screen message rather than a silent allow; recorded a payment and confirmed via fresh `GET`s that a `PaymentReconciliation` exists with the right amount and the Invoice is `balanced`. All test Coverage/ChargeItem/Claim/Invoice/PaymentReconciliation resources created by the verification script were deleted afterward (this is wiring/workflow verification, not demo data meant to persist); Asha Verma's pre-existing Encounter was left untouched.

**A second, independently-notable finding from this round's review/fix cycle: a FHIR `Bundle.type: 'transaction'` is NOT atomic on this Medplum instance, verified live.** The reviewer correctly flagged that `Claim` creation and the bundled `ChargeItem`s' `billable`→`billed` flip were two separate, non-atomic network requests (one `createResource` + a `Promise.all` of `updateResource` PUTs) — a partial failure there (Claim succeeds, one ChargeItem PUT fails) leaves that item still `billable` and selectable into a second Claim, an actual double-bill. The first fix attempt wrapped both into one FHIR transaction `Bundle` and trusted FHIR's documented all-or-nothing semantics — this was then **disproven live**: a transaction Bundle containing a deliberately-invalid `Claim` entry (missing the required `patient` field, forced a 400) alongside a valid `ChargeItem` PUT came back with the Claim entry correctly rejected while the ChargeItem PUT in the *same bundle* still succeeded and persisted. Whatever this Medplum instance does internally for a "transaction" bundle, it is not one all-or-nothing database transaction — a fact worth remembering anywhere else in this codebase that might reach for a transaction Bundle expecting real atomicity (none currently do). The shipped fix: still send one Bundle (fewer round trips, a smaller window than the original N+1 requests), but check every entry's response status individually rather than trusting the bundle as a whole; on any mismatch, the clinician sees exactly which `ChargeItem` ids ended up in which state (billable-with-an-orphan-reference, or billed-with-no-claim-behind-them) so they can manually reconcile, rather than a generic error that hides which items are now inconsistent.

**A third, unrelated real bug caught by this verification, not by code review:** `PaymentReconciliation.paymentDate` is FHIR type `date` (calendar date), not `dateTime` — this Medplum instance 400s a full ISO timestamp there ("Invalid date format") while accepting one fine on the sibling `created` field; `Billing.tsx` truncates to `YYYY-MM-DD` for `paymentDate` only, with a comment warning against "fixing" the two fields to match. **Known gaps, stated plainly (also in `Billing.tsx`'s own header comment and in the UI banner):** no real payer submission/adjudication (above); no `CoverageEligibilityRequest`/`Response` (coverage is taken on faith, not verified with a payer in real time); pricing has no fee schedule, `priceOverride` is a hand-entered total with no unit×quantity math; "Record payment" models an already-collected/recorded payment only, not a live payment-gateway integration (no Stripe/processor credentials exist either); a Claim's `item.productOrService` carries only the ChargeItem's free text, not a back-reference to the ChargeItem id, so `Invoice.lineItem` reconstructs by matching that text rather than a true FK — a tighter design is possible but left as-is this round. Clinician-facing only, no patient-portal view of a patient's own bill — explicitly out of scope, same kind of scoping note `BedBoard.tsx` makes for its own patient-portal exclusion. No new RBAC: any signed-in Practitioner can do every action here, same precedent as `Scheduling.tsx`/`BedBoard.tsx`. |

| 2026-10-19 | **Infra: Medplum's own Postgres upgraded 16 → 18** (`infra/docker-compose.yml`), matching `postgres-hins`'s major version; `medplum/medplum-server`/`medplum-app` (already `:latest`) re-pulled; Keycloak and `postgres-hins` checked and found already current, no change needed | Not an image-tag swap — Postgres major versions aren't binary-compatible data-directory formats, so this was a real `pg_dumpall` (61MB, taken twice — once before starting, once again immediately before stopping the old container) into a fresh `postgres:18` container on a new volume (`medplum-postgres18-data`), with the old volume and a full dump kept as rollback safety nets, not deleted. Verified live, not assumed: row counts for every major resource type (Patient, Encounter, Observation, Condition, DocumentReference, MedicationRequest, Appointment, Location, ChargeItem, Claim, Practitioner) compared exactly between the old pg16 volume (mounted read-only into a throwaway container for comparison) and the new pg18 instance — all matched. Confirmed via a real login + FHIR search against the running instance afterward, not just a row count. Checked Keycloak's `latest` tag against the running 26.8.1 by comparing manifest digests — identical, meaning 26.8.1 already *is* current; no newer major release exists yet, so no migration was needed or attempted there. `postgres-hins`'s `pgvector/pgvector:pg18` image digest likewise already matched the latest available pull — already current. |

| 2026-10-19 | **Pharmacy dispensing built** (`apps/web/src/components/PharmacyDispense.tsx`, rendered inside `VersionedRx.tsx` under each prescription — no new page/route) — closes the §13/§13a "02a — Pharmacy dispensing" roadmap item's data-plumbing half; real interaction/allergy checking remains explicitly blocked on §03.6's medication-coding resolution, not attempted this round | FHIR-native, no new backend service: `MedicationDispense` (`status: 'completed'`, copies the SAME free-text `medicationCodeableConcept.text` already on the `MedicationRequest`, `authorizingPrescription` back-reference, `performer`, `whenHandedOver`, a free-text-adjacent `quantity` — a plain number + free-text unit string like "30 tablets", optional `daysSupply`) covers both outpatient pickup and inpatient ward-stock issue in one code path, per FHIR's own documented dual use of the resource — deliberately not two separate flows. `MedicationAdministration` (`request` back-reference, `performer`, `effectiveDateTime`) records one dose actually given, `status: 'completed'` or `'not-done'` (a skipped dose) with a free-text `statusReason` — a real clinical safety record ("ordered but not given, and why"), not just the happy path. `MedicationRequest.status` is never changed by this feature — a request can be dispensed/administered against multiple times (refills, repeated doses) with **no fulfillment-count or stock/quantity-remaining tracking**, since no real stock ledger exists yet (that's the separate, later "Inventory" roadmap item, §13a); verified live that a second dispense and a second administration against the same still-`active` request both succeed cleanly, by design. The one real guard: only an `active` `MedicationRequest` can be dispensed/administered against, re-checked fresh immediately before every write (`assertStillActive()`), not trusted from the page's load-time snapshot — a clear on-screen message names the actual current status on a block, never a silent no-op. No new RBAC, same precedent as every prior feature: any signed-in Practitioner can dispense or administer; **known gap, stated plainly:** a real pharmacy module would need a distinct Pharmacist role, which this codebase has no mechanism for yet (§10 still open).<br><br>**Two real bugs caught by this round's own live verification, not by code review, both fixed before merge — the second is the more important one:** First, `MedicationAdministration.dosage` with only `.text` set (the field shape the original design called for, matching the resource's own documented intent for free-text dosage) is rejected by this Medplum instance with `Constraint mad-1 not met: SHALL have at least one of dosage.dose or dosage.rate[x]` — the loaded StructureDefinition's invariant does not OR in `text.exists()` the way the base FHIR R4 prose implies. Fabricating a `dosage.dose` Quantity just to satisfy the constraint was rejected as inventing structured data with nothing real behind it (same honest-text convention as medications/discharge dispositions/CPT codes elsewhere); the same free text is instead recorded in `MedicationAdministration.note` (a plain `Annotation[]`, no such constraint, confirmed live), a different FHIR field carrying the identical information. Second, and the one that actually mattered: the first version of `assertStillActive()`'s fresh-recheck read used a plain `medplum.readResource()` — and the live gating test (cancel the `MedicationRequest` via a direct FHIR call from a second session, without reloading the page, then try to dispense through the still-open UI) **initially succeeded when it should have been blocked**, because `@medplum/core`'s `MedplumClient` keeps its own internal response cache and served the stale pre-cancellation copy it had already fetched at page load, with no way to know a different session's PUT had just changed that resource server-side. Fixed by passing `{ cache: 'reload' }` (a standard `RequestInit`-style option `MedplumClient` checks explicitly before its cache) to force a real network round trip on every gate check; re-verified live afterward — the same adversarial sequence (stale page, direct-API cancel, then an in-UI dispense attempt) now correctly blocks with an on-screen message and creates nothing, confirmed by a fresh `GET` showing no new `MedicationDispense`. This cache gotcha is a real, previously-undocumented risk for *any* "recheck fresh right before the write" gate already built in this codebase (`BedBoard.tsx`'s occupancy check, `Billing.tsx`'s Coverage gate) if either ever rereads an id its own client instance had already cached — neither was hit by it in practice (their own verification runs happened not to re-read an already-cached id), but it's flagged here so a future change to either doesn't reintroduce it unknowingly.<br><br>**Verified live** with a real browser (`apps/web` on an alternate port, throwaway Playwright driver — Chromium was already cached from a prior session's `Scheduling.tsx`/`BedBoard.tsx` verification runs, so nothing new was installed) signed in as `dr.sharma@stjones.example` against Asha Verma's existing active `MedicationRequest` ("Ferrous sulfate 325mg", created in an earlier session — reused, not recreated): recorded a dispense (confirmed via fresh `GET` — real `MedicationDispense`, correct `authorizingPrescription`) and an administration (real `MedicationAdministration`, correct `request` reference, correct `note` text); repeated both a second time against the same still-active request with no error (the intentional no-fulfillment-gate behavior); recorded a `not-done` skipped dose with a free-text reason and confirmed it rendered distinctly (red "Not given" badge) in the history list; ran the adversarial gating case described above and confirmed it blocks correctly post-fix. All test `MedicationDispense`/`MedicationAdministration` resources created during verification were deleted afterward (pure verification artifacts, not organic clinical events); Asha Verma's `MedicationRequest` was left exactly as found — `active`, no fulfillment history — same cleanup reasoning `Billing.tsx`'s verification entry already documents for its own test resources. |

This table grows each session the plan is revisited — see §16 for decisions still open.

---

## 01 — Vision & scope

HInS (Health Integrated System) is a single platform a multi-specialty hospital
group runs its entire operation on — registration through discharge, lab through
billing, ward nursing through HR — exposed to every user type through one
consistent, role-scoped interface instead of a dozen stitched-together systems.
Three commitments shape every decision in this document:

- **Modular, not monolithic.** Each clinical/admin domain (§05) is an
  independently deployable service behind a shared identity, consent, and
  terminology layer, so a hospital turns modules on as it grows.
- **Compliant by construction.** DPDP + ABDM consent, HIPAA, and ICMR research
  ethics aren't a checklist applied after the fact — the consent service, audit
  log, and RBAC model (§04, §09, §10) only let a tenant be configured into a
  compliant state, not out of one.
- **AI-native, provider-agnostic.** Every AI function runs through one gateway
  where an admin chooses local, self-hosted, or frontier-provider models per
  function, with redaction and guardrails mandatory on every path (§08).

## 02 — Reference deployment: St. Jones Multi-Specialty Hospital

Used throughout to size modules and write test cases against a concrete shape
of organization.

| | |
|---|---|
| Beds | 450, across ICU, NICU, general ward, 6 operating theatres |
| Departments | Cardiology, Oncology, Orthopedics, Pediatrics, OB-GYN, Nephrology, Emergency, General Medicine, Radiology, Pathology |
| Sites | 1 flagship campus + 3 satellite OPD clinics, same tenant |
| Staff | ~180 physicians, ~600 nursing staff, lab/radiology techs, pharmacy, billing/RCM, HR, facilities, IT |
| Volume | ~1,400 OPD visits/day, ~60 admissions/day, 24×7 ER |
| Jurisdiction | India (ABDM-participating) — the stricter of the two target jurisdictions; a second US reference tenant exercises the HIPAA path |

## 03 — Compliance framework

Each tenant is assigned a **compliance mode** (India / US / both) that turns on
the matching consent flow, breach-notification workflow, and data-residency
default.

| Framework | Jurisdiction | Governs | Platform obligation |
|---|---|---|---|
| DPDP Act 2023 + Rules 2025 | India | All personal data processing | Granular, revocable, purpose-bound consent; interoperable Consent Manager support; Data Protection Board breach notice; phased commencement (§03.1) |
| ABDM — ABHA, HIE-CM, NHCX | India | Cross-facility health data + claims exchange | FHIR R4 bundles conforming to the ABDM FHIR IG (§03.8); HIP/HIU roles; signed per-source consent artefacts; no central repository (§04) |
| ICMR National Ethical Guidelines (2017) | India | Human-participant research | Ethics-committee-approved informed consent; broad-consent & waiver handling; child assent |
| HIPAA — Privacy, Security, Breach Notification | United States | PHI at covered entities/business associates | Minimum-necessary access, including by AI functions (§08.4); encryption at rest/in transit; named Security + Privacy Officials; signed BAA with every PHI-touching vendor, AI providers included |
| Section 1557 (ACA) · 42 CFR Part 2 | United States | Nondiscrimination in clinical AI tools; substance-use-disorder records | Bias identification/mitigation for any AI input correlated with a protected class (§03.4a); SUD records need their own consent subtype, not generic `treatment_authorization` |
| USCDI v3 / US Core 6.1.0 / SMART App Launch 2.2.0 / Info Blocking (45 CFR Part 171) | United States | Data portability & interoperability duties | FHIR resources must be US-Core-*conformant*, not just FHIR-*shaped* (§03.7); patient's own access to their own record can't be limited outside a recognized exception |
| SNOMED CT · LOINC · ICD-10 · CDCI/RxNorm · HL7v2 · FHIR R4 · DICOM | Global · India via NRCeS | Clinical terminology & interoperability | FHIR R4 as the API backbone; coded, not free-text, problems/labs/medications/orders wherever a terminology exists (§03.5–03.8) |

**03.1 India — DPDP Act & Rules.** The DPDP Rules, 2025 (Gazette **G.S.R.
846(E)**, notified 13–14 Nov 2025 — sources disagree by a day; confirm
against the Gazette text before this date is load-bearing anywhere) commence
in phases: the Data Protection Board's own constitution and the Consent
Manager registration machinery took effect on notification; the substantive
obligations that actually govern how HInS behaves — SDF duties, breach
notification, parental consent, cross-border mechanics, the research
exemption — are reported, consistently across independent sources, as
commencing roughly 18 months later, **around 13 May 2027** (high-confidence,
not primary-verified). No Data Protection Board Chairperson/Members are
confirmed appointed and no penalty order has been reported — enforcement
risk is a forward design target today, not a live one; treat any vendor
claim of a "first DPDP fine" as fabricated or confused with a different
regime (IT Act §43A, CERT-In) until shown otherwise.

**DPDP has no "sensitive personal data" tier.** Unlike GDPR Art. 9, and
unlike India's own prior SPDI Rules 2011 (which *did* carve out health data),
the enacted Act gives health data no special category of its own. Any
elevated protection it gets comes from sectoral sources layered on top —
Clinical Establishments Rules, MoHFW's 2016 EHR Standards (§03.5), ABDM's
Health Data Management Policy — not from DPDP's text. This blueprint should
not imply DPDP itself treats health data specially.

Consent must be free, specific, informed, revocable, one notice per purpose
(Section 6). The "essential services" carve-out for hospitals applies only
once government-notified — not yet. **Breach notification (Rule 7) has no
risk/harm threshold** — every breach is reported, full stop; stricter than
both HIPAA's documented four-factor risk assessment and GDPR's risk-based
trigger. Two-stage: intimation "without delay," a detailed report to the
Board within 72 hours; individual notice is "without delay" too, with the
exact SLA (also 72h, or genuinely open-ended) disputed across sources —
confirm against the Gazette before §09/§15's breach workflow hard-codes a
number. Penalties: up to ₹250 crore for inadequate safeguards, up to ₹200
crore for failing to notify — separate, stackable, per instance.

**Children (Section 9, Rule 10):** verifiable parental/guardian consent is
required under 18, with the parent's/guardian's own identity *and*
relationship/age verified by a reliable means (e.g. DigiLocker) — a
self-certifying checkbox is explicitly insufficient. Tracking, behavioural
monitoring, and targeted advertising toward a child are barred **even with
valid consent** — not consent-curable. A possible healthcare-sector exemption
exists in principle (§9(4)/(5) + Fourth Schedule) but is not confirmed
notified — build to the strict baseline. **This is a live gap in the current
build, not a future compliance deadline:** §04.4's "guardian/LAR" grantor
type is schema-present but not functionally usable — approve/deny (2026-10-18)
only ever accepts the patient's own resolved identity — and St. Jones already
has a pediatrics department (§02). See the §04.4 update below.

**Significant Data Fiduciary (SDF):** no numeric designation thresholds are
officially notified — any blog-cited figure is uncorroborated speculation,
not DPDP text. Hospital-scale health platforms are widely discussed as
plausible SDF candidates on sensitivity-of-data alone. If/when designated:
an India-resident DPO reporting to the governing board; an independent data
auditor, structurally separate from the DPO; a Rule-13 DPIA + audit every 12
months; **algorithmic/software due-diligence** — directly relevant to §08:
if the platform or a tenant is ever SDF-designated, every AI Gateway
function touching patient data needs this due-diligence, not just the
frontier-model BAA question §08 already tracks; and a narrower Rule 13(4)
power to require specified data categories processed only within India,
distinct from and tighter than the general cross-border rule below.

**Cross-border transfer (Section 16)** is a negative-list model — the
opposite of GDPR's adequacy-list approach: transfer is permitted everywhere
except countries the government specifically restricts by notification. No
restricted-country list exists yet, so sending Indian patients' data to a
frontier model hosted outside India is **not independently blocked by
Section 16 today** — don't let this blueprint imply a live DPDP
data-residency requirement that doesn't yet exist. Track the first
restricted-country notification as the trigger to re-architect §08's AI
Gateway routing for India-mode tenants.

**Research/archiving/statistical exemption** (§17(2)(b), Rule 16, Second
Schedule) is conditional on adherence to the Schedule's own standards — **the
Second Schedule text itself has not been retrieved/verified against the
primary Gazette document; don't treat deid-service's methods (§11) as a
confirmed DPDP legal safe harbor specifically** until that's checked, only as
independently justified under HIPAA/GDPR. The exemption explicitly does
**not** cover processing used to decide about an identifiable individual — a
sharp, previously-unstated implication: active clinical-trial enrollment,
dosing, and continuation/withdrawal decisions plausibly fall **outside** this
exemption even when routed through the same de-identification pipeline as
aggregate research use. Conflating "de-identified" with "DPDP-exempt" is a
real compliance error this blueprint didn't previously guard against.

**Who is the Data Fiduciary, exactly?** Each hospital tenant is the Data
Fiduciary for its own patients; HInS-as-platform is a Data Processor when
merely operating software on a hospital's instructions. **HInS likely
becomes an independent or co-Data Fiduciary for the cross-tenant research
warehouse specifically (§11, §16)**, since that processing's purpose is
determined by HInS, not any one hospital — this is inference from DPDP's own
fiduciary/processor definitions, not a cited finding about HInS, and needs a
real legal opinion before being treated as settled. It determines who owes
the DPO/breach/grievance obligations for that data flow.

**03.1a DPDP Consent Manager vs. ABDM Consent Manager (HIE-CM) — do not
conflate.** These share the English phrase but are legally distinct systems:
ABDM's is health-sector-only, mandatory for cross-facility exchange, NHA-
empanelled via an M1→M2→M3 sandbox process; DPDP's is sector-agnostic,
**optional for the Data Principal** (DPDP's default is direct
fiduciary-to-principal consent under Section 6), and registered with the
Data Protection Board rather than NHA. Both independently require the router
itself be architecturally unable to read the data it routes — the same
"router never sees plaintext" principle arrived at twice, in two separate
regimes (see also NHCX, §03.8). **Good news for the current build, stated
plainly:** the patient-direct consent dashboard already built (grant/revoke,
the pending-approval round trip) is legitimate, standalone DPDP consent — **no
DPDP Consent Manager integration is required for DPDP compliance.** What
remains open is the separate ABDM HIE-CM integration for cross-facility
exchange (§04.2, §03.8) — don't let "we built consent" collapse these two
into one solved problem.

**03.2 India — ABDM consent model.** Federated by design: records stay at the
originating HIP and move only via a signed consent artefact scoped to a
specific HIU, purpose, and time window. No central repository to protect or
leak.

**03.3 India — ICMR research ethics.** Any research/analytics data path (§11)
sits downstream of ICMR's consent rules — written, ethics-committee-approved,
with broad consent, waiver-by-committee, and child assent as distinct,
trackable types. See §04.1's update below — the current ledger's single
`research` type can't yet represent these as distinct, trackable values.

**03.4 United States — HIPAA.** *Status, re-verified:* the Security Rule NPRM
(Federal Register, Jan 6 2025; comments closed Mar 7 2025, ~4,745–4,747
comments) remains unfinalized. HHS's own target has slipped from spring 2025,
to ~May 2026, to the current Unified Agenda entry (RIN 0945-AA22) listing
**July 2027**, now a Long-Term Action (conventionally: no action expected
within 12 months); 100+ hospital/provider groups have asked HHS to
**withdraw** it outright, not just delay it. The currently enforceable law is
still the 2013 Omnibus Security Rule. Build to the proposed bar anyway, but
state the status honestly — "proposed since Jan 2025, agency's own target now
July 2027, actively opposed, genuinely uncertain," not "coming in 2026." This
blueprint's existing "access revoked within 1 hour of termination" figure
could not be re-verified against the NPRM text — neither could an
alternative "24 hours" found in secondary sources; don't carry either forward
with false confidence until checked against the Federal Register text
directly.

**"Addressable" does not mean optional, today, under the already-enforceable
rule** — a covered entity must adopt it or a documented equivalent with
written reasoning; skipping it with no analysis is a gap, not a permitted
choice. Two specs are unconditionally **Required**, no exceptions: unique
user/entity identification and person/entity authentication (45 CFR
§164.312(a)(2)(i), (d)) — every human *and machine* caller, including the AI
Gateway's own service identity, needs its own verifiable identity, never a
shared credential. This is exactly what the 2026-10-18 hardening (deid-service
off the shared admin login onto a `client_credentials` identity) closed —
correctly understood as a Required safeguard, not a nice-to-have.

**Two named roles are required right now, unconditionally, zero staging
delay** — 45 CFR §164.308(a)(2) requires a named **Security Official**;
§164.530(a) separately requires a named **Privacy Official** (one person can
hold both). **Neither is currently named anywhere in this project.** Across
every regulatory domain in this document, this is the one gap that's already,
unconditionally, legally binding the moment real PHI (not synthetic St.
Jones data) touches the system — not staged to a future date the way most of
DPDP's substantive obligations are. Build to the proposed bar too: encryption
at rest/in transit, mandatory MFA, network segmentation, annual asset
inventory, biannual vulnerability scans, annual pen tests, DR restoring
service within 72 hours. Every business associate needs written,
annually-reverified safeguard verification.

**03.4a Adjacent US obligations, not previously tracked.** **Section 1557**
(ACA nondiscrimination, final rule effective Jul 5 2024, 45 CFR Part 92
§92.210) reaches "any automated or non-automated tool... including AI" used
to support clinical decision-making — plainly covers the CDSS (§05) and the
voice-pipeline's structuring step (§08.1 step 4). Covered entities must make
reasonable efforts to **identify** uses where race, color, national origin,
sex, age, or disability (including proxies) are input variables, and
**mitigate** discrimination risk — compliance deadline was **May 1 2025;
already live today**, independent of HIPAA. No module currently has a
documented bias-evaluation step. **The 2024 HIPAA Reproductive Health Privacy
Rule was vacated nationwide** (*Purl v. HHS*, N.D. Tex., Jun 18 2025; sources
disagree on exact scope). The pre-2024 federal baseline is back — any extra
reproductive-health-PHI protection now depends entirely on the individual US
state a tenant operates in. Not fixable by a platform control; it's per-tenant
state-law review the moment a US hospital in an affected state onboards.
**42 CFR Part 2** (substance-use-disorder records) was realigned with HIPAA
(final rule, compliance deadline Feb 16 2026, passed) — one consent can now
cover future TPO uses — but Part 2's protection against using SUD
records/testimony against a patient in legal proceedings, absent separate
consent or a court order, survives untouched. That would be silently lost if
a substance-use diagnosis is tagged like any other `Condition` under generic
`treatment_authorization` (§04.1) — argues for a distinct SUD-records consent
subtype, not a storage change.

**03.5 Terminology & interoperability — India.** India has been a SNOMED
International member since March 2014; C-DAC Pune's NRCeS is the National
Release Centre. India's 2016 MoHFW EHR Standards normatively name **SNOMED
CT**, **LOINC** (free worldwide, no license — already correctly used in
seed data, zero remaining gap on this axis), **ICD-10** for
classification/reporting, plus HL7 v2.8.2 for messaging, HL7 CCD R1 for
summaries, and DICOM for images/waveforms — and notably do **not** mention
FHIR normatively at all; ABDM's FHIR-centric layer (§03.8) is additional to,
not a replacement for, this still-current standard. Practical implication: a
platform conformant only to the ABDM FHIR layer may still be unable to talk
to a hospital's existing lab/radiology infrastructure built against HL7v2/
CCD/DICOM — relevant the moment HInS interfaces with a hospital's own
pre-existing instruments (§05, §13). **ICD-10 vs. ICD-11:** NRCeS's own
guidance names ICD-10 as current; one secondary source's "ICD-11 (2016)"
claim is internally impossible (ICD-11 wasn't WHO-adopted until 2019) and
should be treated as an error. India has separately engaged ICD-11 for
**AYUSH traditional-medicine coding only** (NAMASTE→ICD-11 TM2 mapping, WHO
"Blue Browser," Feb 2025) — not a general mandate. Default India-mode
`Condition` coding to ICD-10; treat ICD-11/TM2 as a distinct, optional,
AYUSH-specific item if that scope is ever added (not currently in scope).
Confirm this against the primary 2016 MoHFW document before treating it as
fully settled. Globally, WHO's own figures (May 2024) show only 14 of 132
Member States reporting in ICD-11 — a dual India+US platform should expect
ICD-10 as the dominant real-world code for the foreseeable future.

**03.6 SNOMED CT India — licensing, and the real drug-coding standard.** The
"affiliate license" NRCeS/C-DAC Pune administers via SNOMED International's
Member Licensing & Distribution Service (MLDS) is a **free, administrative
registration**, not a commercial purchase — obtained via the MLDS portal,
biannual release access. This re-reads terminology-service's stated blocker
("needs a licensed SNOMED CT India edition, not available in this
environment") as substantially smaller than it sounds: **a days-to-weeks
administrative step, not a multi-month procurement dependency.** One real
nuance: MLDS terms reportedly restrict a sublicensee's default rights to
"exploring and evaluating" — a hospital tenant deploying HInS commercially in
India may need its own sublicense, distinct from HInS's own affiliate
registration; resolve with counsel or NRCeS directly. **India's real analog
to RxNorm has a name: "Common Drug Codes for India" (CDCI)**, distributed as
the SNOMED CT India Drug Extension (module `IN1000189`), synchronized
biannually, through the same MLDS mechanism — not a second procurement path.
Coverage is in the tens of thousands of generic/branded concepts and growing;
confirm exact current figures against NRCeS's own release notes before
citing precisely. It is **not** RxNorm-compatible — US-tenant medications
still need RxNorm (NLM, free API use; bulk data needs a one-time free UMLS
license) — so a dual-jurisdiction platform ends up with two separate,
non-interoperable medication-coding pipelines, one per jurisdiction. **This
is the sharpest concrete AI/automation blocker found in this research round:**
a drug-interaction/allergy CDSS check (already named in §05's module catalog)
works by looking up two *coded* drug concepts against a known interaction
database — with medications stored as free text, there is no concept ID to
look up, so the checker cannot run **at all**, for any prescription, not a
degraded version of one. Wiring CDCI (India) or RxNorm (US) into
`MedicationRequest.medicationCodeableConcept` at entry time — ideally picked
from a coded formulary at the point of e-prescribing, not free-typed — is the
literal precondition for a real drug-interaction CDSS to exist, not an
incremental improvement to one that already does.

**03.7 United States — USCDI, US Core, SMART App Launch, Information
Blocking, TEFCA.** HIPAA (§03.4) is only half the US surface relevant to
"fully wired EHR" — the other half governs data *portability and
interoperability* duties, the specific axis "standardization unlocks AI
value" lives on. **USCDI v3, paired with US Core 6.1.0 and SMART App Launch
2.0.0, is the ONC-certification-mandatory baseline under the HTI-1 final
rule** — not v4+ (voluntary; a proposal to move the mandatory baseline to v4
was withdrawn Dec 29 2025). Set HInS's US FHIR-conformance floor at US Core
6.1.0 / USCDI v3 now; treat v4+ as optional future-proofing, and re-check this
on a recurring cadence (ONC ships a new USCDI version roughly annually) —
don't treat it as settled once written down. USCDI's data classes, each
mapped in US Core to a specific FHIR profile, are the actual element-by-
element answer to "which FHIR profile does this clinical fact belong in" —
HInS's current `DocumentReference`/`Observation`/`Condition` usage is
FHIR-*shaped* but not yet US-Core-*conformant*, which is the real bar for
"this talks to a US hospital's EHR or payer," not merely "uses FHIR."
**SMART App Launch's current published edition is v2.2.0** (finer-grained,
search-parameter-scoped scopes, e.g. `patient/Observation.rs?category=
vital-signs`; mandatory PKCE) — §05's Patient Portal names "SMART on FHIR"
as an aspiration with no actual OAuth2/launch-context/scope model built yet.
This matters beyond third-party apps: **the SMART scope grammar is also the
natural mechanism for §08.4's per-function AI access scoping** — adopt it now
rather than invent a parallel scheme later, so the same mechanism serves both
a real third-party app and HInS's own internal AI-access scoping.
**Information blocking (45 CFR Part 171)** presumes interference with
access/exchange/use of EHI is prohibited unless a recognized exception
applies. Gating a patient's own access on consent status is not information
blocking under the Privacy Exception's conditions — the real, currently
undocumented exposure is any future design that limits what a patient's own
portal, or a third-party app they authorized, can pull from their *own*
record outside a recognized exception (distinct from the research-export
question, §11). **TEFCA** requires (as of Jan 1 2026) exchange to conform to
USCDI v3; no regulation mandates TEFCA/QHIN participation — it's
incentive-shaped via information-blocking exposure, not a hard requirement —
so HInS doesn't need QHIN capability to launch, but "eventually interoperate
via TEFCA" is a real near-term direction worth naming explicitly.

**03.8 ABDM FHIR Implementation Guide and NHCX — the real HIP conformance
target.** §03.2's "FHIR R4 bundles" is accurate but names no actual
conformance target — there is one: NRCeS's **FHIR Implementation Guide for
ABDM**, R4-based (the same base Medplum already runs), reported at
v6.5.0–v7.0.0 depending on source — confirm the current number against
`nrces.in/ndhm/fhir/r4/` before citing one specifically. It defines seven
Composition-based "record" document profiles, one per ABDM Health
Information type (`OPConsultRecord`, `DischargeSummaryRecord`,
`DiagnosticReportRecord`, `PrescriptionRecord`, `WellnessRecord`,
`ImmunizationRecord`, `HealthDocumentRecord`, plus `InvoiceRecord` for
billing), each packaged in a shared `DocumentBundle` profile, over ~25–34
underlying resource profiles (`Patient`, `Encounter`, `Condition`,
`MedicationRequest`, six specialized `Observation` sub-profiles, split
`DiagnosticReportLab`/`DiagnosticReportImaging`, etc.). **This is a literal,
resource-level gap, not an aspirational one: `apps/web` produces raw Medplum
FHIR resources but does not assemble any of the seven ABDM Composition
"Record" bundles.** That's the specific, scoped difference between
"FHIR-native" (already true) and "ABDM M2/HIP-conformant" (not yet true) —
and the actual precondition for §04's already-built consent-approval
mechanics to have anything valid to hand over once a request is approved.
Closing the consent-ownership gap (2026-10-18) made the *authorization*
correct; it doesn't make the *exchange* real. The real HIU-side protocol: the
HIU calls `/consent-requests/init` on the ABDM Gateway (callback-based);
transfer requests carry the consent ID plus the HIU's ECDH public key
(Curve25519) and a nonce; bundles are AES-256-GCM encrypted via a scheme
called **Fidelius**, the Gateway itself never seeing plaintext — the concrete
mechanism behind §04.2's existing "no central repository" claim. The real
consent artefact also carries a per-artifact ephemeral encryption keypair and
a storage-duration field distinct from the validity window — both currently
absent from §04.1's ledger schema, needed before real HIP/HIU
interoperability, independent of the §16 build-vs-integrate-a-consent-manager
question. **NHCX** (National Health Claims Exchange, live since mid-2024,
NHA+IRDAI, FHIR-based) is explicitly a router, not a repository — the same
"data-blind-router" principle as the DPDP Consent Manager (§03.1a) and ABDM's
HIE-CM, appearing a third time in India's regulatory pattern — using the same
`Claim`/`ExplanationOfBenefit`/`Coverage` resource family Medplum already
supports natively for the US billing path (§13), meaning the India side of
the still-unbuilt RCM module may need *less* custom work than the US side,
not more, once the shared FHIR model is right. Sources genuinely disagree on
whether NHCX onboarding is IRDAI-mandated or voluntary-but-encouraged —
resolve before committing a build-order slot (§13), since mandatory-vs-
voluntary materially changes priority.

> **Not legal advice.** §03 synthesizes public secondary sources — most
> claims re-verified by live research as of 2026-10-19, several explicitly
> flagged above where sources disagreed or a primary legal text couldn't be
> retrieved/confirmed. Treat it as a briefing for counsel, not a substitute —
> especially the Second Schedule's actual text, the research-warehouse
> Data-Fiduciary question, the SDF-designation question, and anywhere a date
> or figure is flagged as "disputed" or "unconfirmed" above.

## 04 — Consent management architecture

Four consent concepts coexist without collapsing into one checkbox: DPDP
processing consent, ABDM's per-HIP data-sharing artefact, HIPAA
treatment/payment/operations authorization, and ICMR research consent. Consent
is a first-class domain service, not a field on the patient record.

**04.1 Consent Service.** Every consent event is an immutable, append-only
record:

| Field | Purpose |
|---|---|
| `consent_id` | Unique, immutable — the audit anchor |
| `type` | `data_sharing` (ABDM) · `treatment_authorization` (HIPAA) · `research` (ICMR) · `recording` (voice/video, §08) · `marketing` |
| `research` sub-type | **Not yet distinct values, per §03.6 research findings:** ICMR names five ethics-committee-approvable research-consent kinds — broad consent (reusable for future not-yet-specified studies within set bounds), verbal/oral consent, group consent, waiver of consent, re-consent. Today's single `type=research` can't tell a reusable broad grant from a one-time narrow one — exactly the distinction an ethics committee requires trackable, and that any future research-cohort auto-matching feature needs to not over- or under-reach |
| `grantor` | Patient, or verified parent/guardian (DPDP §9/Rule 10) for minors, or LAR for persons with disabilities — see §04.4, this is schema-present but not yet functionally distinct from the patient actor in the built approve/deny flow |
| `scope` | In-scope health information types — never "everything" |
| `purpose_code` | Self-use · treatment · payment · research — bound to the request |
| `requester` | The specific HIU/system/study requesting access |
| `validity` | Start + expiry — no indefinite grants |
| `status` | `granted` · `revoked` · `expired` |
| `signature` | Cryptographic signature, for ABDM interop and audit |

**04.2 ABDM consent-artefact flow.** HIU requests records → Consent Manager
routes to the patient's PHR app → patient approves/denies there, never inside
HInS's own UI → one signed artefact generated per HIP involved → HInS (as HIP)
validates the artefact before releasing an encrypted FHIR bundle.

**04.3 Revocation & propagation.** The most commonly reported ABDM failure is
a revoke that doesn't reach every HIP that received data under the original
grant. Revocation is SLA-backed and monitored: a revoke writes a new consent
record, fans out propagation to every recipient on that artefact's
distribution list, and tracks per-recipient confirmation (risk + test case in
§15, §14 TC-02).

**04.4 Guardians, minors, emergency override.** A distinct legally-authorized-
representative grantor type, not a workaround on the patient's account — that
was always the *intent*, but **per the 2026-10-18 consent-ownership fix, the
built system only ever accepts the patient's own resolved Medplum identity**;
`grantor.representative` is schema-present, not functionally usable, and this
is a live DPDP Section 9/Rule 10 gap today (§03.1), not a hypothetical one —
St. Jones already has a pediatrics department (§02). Closing it needs
**three** distinct actor types, not two: (1) the patient; (2) a **verified**
parent/guardian per Rule 10 — with an actual identity-*and*-relationship
verification step, not a self-certifying checkbox; and (3), separately, a
pediatric research participant's own **assent** alongside parental consent
(ICMR's distinct concept for research specifically, §03.3). A separate
break-glass path (§09) allows emergency access without prior consent —
logged, time-boxed, mandatory 24-hour post-hoc review.

**04.5 Consent UX.** Plain-language notices, one per purpose. Every active
grant visible and revocable from the patient portal in one action. Recording
consent (§08) captured per encounter, separate from standing data-sharing
consent.

## 05 — Module catalog

Every module is a bounded service behind the shared identity, consent,
terminology, and audit layers (§06).

**Clinical & diagnostic**

| Module | Function | Open-source anchor |
|---|---|---|
| HIS core | Registration, scheduling, bed/ward management, doctor rounds | **Confirmed:** Medplum (Apache-2.0) |
| EMR/EHR | Encounter notes, problem list, vitals, MAR | **Confirmed:** Medplum FHIR datastore; OpenMRS clinical data model as reference only |
| LIS | Lab orders, specimen tracking, results to chart | OpenELIS, as unmodified network service (§07) |
| RIS/PACS | Image capture, archive, distribution | Orthanc (archive) + OHIF (viewer) |
| CDSS | Drug-interaction, allergy, guideline alerts | Rules engine + AI layer (§08), advisory only |
| e-Prescribing | Digital prescriptions | FHIR `MedicationRequest` + pharmacy integration |

**Administrative & financial**

| Module | Function | Open-source anchor |
|---|---|---|
| RCM/Billing | Claims, patient billing, payment tracking | Custom, FHIR `Claim`/`ExplanationOfBenefit` |
| ERP | HR/payroll, supply chain, procurement, accounting | Frappe framework (MIT) + ERPNext app as unmodified service, or custom build on Frappe (§07) |

**Digital health layers**

| Module | Function | Open-source anchor |
|---|---|---|
| Telehealth | Video consultation, remote triage | WebRTC, integrated with HIS scheduling |
| IoMT | Smart-bed, wearable, ICU telemetry | HL7 device profiles → FHIR `Observation` |
| Patient Portal | Results, appointments, bills, consent management | SMART on FHIR app against the core API |

## 06 — Reference architecture

One FHIR-native core (Medplum), reached only through an API gateway, with
identity, consent, terminology, audit, and the AI gateway as cross-cutting
services every domain module shares rather than reimplements. Diagram: see
the published artifact (§ link above) for the full architecture visual.

**Layers, top to bottom:**

1. **Edge/consumers** — Patient Portal, Telehealth, 3rd-party SMART on FHIR
   apps, research analytics consumers, ABDM/HIE.
2. **Gateway** — API Gateway: FHIR R4 REST + SMART on FHIR, granular scopes,
   Bulk `$export`, FHIR Subscriptions.
3. **Cross-cutting services** — Identity & Access (IAM), Consent Service,
   Terminology Service, AI Gateway + Guardrails, Audit & Logging, Tenant
   Config/White-label. Built as Fastify + Drizzle services (Decisions log,
   2026-10-15) against their own dedicated Postgres instance — deliberately
   not sharing Medplum's database (below), so our schema migrations never
   touch Medplum's internal one.
4. **Core Clinical Engine** — Medplum FHIR datastore (HIS/EMR/EHR), on its
   own `postgres:16`, pinned to what Medplum ships tested against.
5. **Domain services** — LIS, RIS/PACS, CDSS, Pharmacy/eRx, reached via an
   Integration Engine that also bridges to ERP/RCM and IoMT.
6. **Research path** — De-identification pipeline (Safe Harbor/Expert/
   synthetic) feeding a logically isolated Research Data Warehouse.

**06.1 Why an integration engine, not point-to-point links.** LIS, RIS/PACS,
ERP, and IoMT devices never connect directly to each other or the core.
Everything routes through one integration engine translating HL7v2/DICOM/
device protocols into FHIR against the core — one place to add a new
instrument, one place to audit every cross-system data flow.

## 07 — Open-source & licensing strategy

Core constraint: use open source without ending up obligated to publish HInS's
own code. This is almost entirely about copyleft, specifically the difference
between GPL (triggered by *distributing* a modified binary) and AGPL
(triggered by *letting users interact with a modified version over a
network* — exactly what a SaaS product does). Using an AGPL/GPL component
**unmodified**, as a black-box network service, does not pull your own code
under that license. **Modifying** that component's own source and operating
the modified version is what triggers disclosure.

| Need | Candidate | License | Risk | Safe usage pattern |
|---|---|---|---|---|
| FHIR datastore / clinical core — **confirmed** | Medplum | Apache-2.0 | permissive | Core is Apache-2.0; confirm which hosted services are commercial-only. Selected 2026-10-15. |
| FHIR datastore — alternative | HAPI FHIR | Apache-2.0 | permissive | Fork freely — Java-stack alternative if Medplum's TS stack isn't the right fit |
| Clinical data model reference | OpenMRS core | MPL-2.0 | weak copyleft | Use freely; share back only modified MPL-covered files |
| Full EMR distribution | Bahmni | AGPL-3.0* | strong copyleft | Unmodified service only — do not fork. *Nov 2025 proposal to relicense to MPL-2.0/MIT; confirm current status |
| Lab information system | OpenELIS | AGPL-3.0 | strong copyleft | Unmodified network service only |
| Integration engine | NextGen Connect (Mirth) | proprietary ≥4.6 | now closed | Last OSS release 4.5.2 (MPL-2.0, frozen); use Open Integration Engine fork, or budget commercial license |
| Identity & access | Keycloak | Apache-2.0 | permissive | Fork freely; realm-per-tenant or Organizations feature |
| Identity, modular alt. | Ory (Kratos/Hydra/Keto) | Apache-2.0 | permissive | Compose as microservices |
| DICOM archive | Orthanc core | GPL-3.0 | copyleft, distribution-triggered | Safe unmodified; forking requires sharing those changes |
| DICOM archive plugin | Orthanc DICOMweb plugin | AGPL-3.0 | strong copyleft | Unmodified only |
| DICOM viewer | OHIF Viewer | MIT | permissive | Fork freely |
| ERP framework | Frappe | MIT | permissive | Build custom modules directly |
| ERP app | ERPNext | GPL-3.0 | copyleft, distribution-triggered | Integrate unmodified via API, don't fork the app |
| PII/PHI redaction | Microsoft Presidio | MIT | permissive | Use freely; pair with a clinical-tuned NER model — 2026 benchmark: 0.61 precision/0.91 recall on clinical text vs. ~0.99 for clinical-specific models |
| LLM guardrails | NeMo Guardrails | Apache-2.0 | permissive | Fork freely |
| Safety classifier | Llama Guard | Llama community license | source-available, not OSI | Review Meta's acceptable-use terms before production |
| Speech-to-text | Whisper large-v3 | MIT | permissive | Self-host freely |
| Backend web framework — **confirmed** | Fastify 5 | MIT | permissive | Fork freely. Selected 2026-10-15 over Hono (built for edge/multi-runtime, not needed here) and Express (maintenance-mode, weaker TS inference) |
| Schema validation | Zod 4 | MIT | permissive | Via `fastify-type-provider-zod` |
| ORM — **confirmed** | Drizzle ORM | Apache-2.0 | permissive | Selected 2026-10-15 over Prisma — SQL-fluent, no codegen step |
| Vector/embeddings store | pgvector | PostgreSQL License | permissive | Ships in the `pgvector/pgvector:pg18` image used for HInS's own services (§06) |
| Frontend framework — **confirmed (not a free choice)** | React 18/19 | MIT | permissive | Pinned by `@medplum/react`'s peer deps. Selected 2026-10-15 |
| Frontend UI kit | Mantine | MIT | permissive | Ships with `@medplum/react` — reuse it rather than adding a second component system |

> **Get this reviewed before building on it.** License identification above
> comes from public secondary sources that sometimes disagreed with each
> other (ERPNext's license was reported as both GPL-3.0 and MIT). Have counsel
> confirm every AGPL/GPL entry, and the Bahmni relicensing status
> specifically, before an engineering decision depends on it.

## 08 — AI architecture & voice documentation

No function is hard-wired to one AI vendor. Every AI call passes through one
AI Gateway, where a tenant admin picks the backing model **per function**:

| Tier | Where it runs | Trade-off |
|---|---|---|
| Local | Clinical workstation/edge | Offline, strongest privacy, lowest capability — fits ward-device transcription |
| Self-hosted, open-weight | Hospital- or platform-controlled infra (e.g. vLLM) | Data never leaves the tenant's jurisdiction; no third-party BAA needed |
| Frontier provider | Claude/GPT/Gemini via API, signed BAA/DPA | Highest capability; requires per-vendor review and mandatory redaction before anything leaves the tenant boundary |

**08.1 Ambient voice documentation pipeline.**

1. **Recording consent** — captured per encounter (§04.5), logged as its own
   consent record, visible recording indicator for both parties. No consent
   event, no microphone access.
2. **Capture & transcription** — self-hosted Whisper by default; frontier/
   cloud ASR is opt-in only, gated on a BAA being on file.
3. **De-identification pass** — Presidio + clinical NER strips incidental
   third-party PII before any frontier-model call.
4. **Structuring** — transcript → draft SOAP note mapped to FHIR
   `Encounter`/`Observation`/`Condition`, with suggested SNOMED CT/ICD codes.
5. **Clinician review** — draft is never final; nothing reaches the legal
   record unsigned.
6. **Commit & cleanup** — on sign-off, note commits to chart; raw audio
   deleted immediately by default (separate consent required to retain for
   QA).

**08.2 Care-setting variants.**

| Setting | What's different | Structuring output |
|---|---|---|
| OPD/clinic | Short, single-patient encounter; one recording per visit; consent captured once at check-in | SOAP note on a single `Encounter`, with eRx/follow-up drafted alongside |
| Inpatient/ward rounds | One recording covers multiple patients in sequence; audio must be segmented per bed/patient before structuring; nursing notes feed the same pipeline | Per-patient progress notes on each patient's own `Encounter` — misattribution is a patient-safety incident, not a transcription bug, and blocks auto-commit |
| Discharge | Draws on the full stay, not one conversation; summarizes across prior notes rather than transcribing fresh audio | Discharge summary draft, still clinician-reviewed and signed |

Medplum's **Bots** (serverless TypeScript functions triggered on FHIR
resource events) are the attachment point for all three: an `Encounter`
moving to `in-progress` triggers the consent check; a completed recording
triggers the ASR → redaction → structuring chain as a Bot pipeline; Access
Policies (Medplum's native RBAC/ABAC primitive, §10) gate who the draft is
visible to before sign-off. The AI layer stays configuration and Bot code on
top of the confirmed core, never a fork of it.

**08.3 Guardrails, on every path.**

- **Pre-call:** PII/PHI redaction (Presidio + clinical NER), prompt-injection
  screening.
- **Post-call:** Llama-Guard-class output classification; groundedness check
  against source chart data.
- **CDSS specifically:** every suggestion labeled decision support, never a
  diagnosis; every override/dismissal logged with reason.
- **No autonomous writes.** No AI function places an order, signs a note, or
  commits a chart entry on its own.

**08.4 Minimum necessary — a per-function access scope, not a prompt
instruction.** HIPAA's minimum-necessary standard (45 CFR §164.502(b),
§164.514(d)) governs an AI feature's read access to the chart as an internal
**use**, not a provider-to-provider treatment **disclosure** — the
§164.502(b)(2)(i) treatment exception does **not** cover this.
§164.514(d)(5) specifically bars using or requesting an entire medical record
absent a function-specific justification. The default engineering
temptation — give every AI function the whole FHIR Patient compartment and
let the model sort out relevance — is exactly the pattern this standard
rules out. **A system-prompt instruction telling the model to "only use
relevant information" is not a data-access control** — unenforced below the
model layer, unauditable as a boundary, bypassable by prompt injection or a
silent model-version change, and gives no artifact to show an OCR
investigator "here is what this call was permitted to see, and proof it saw
only that." The concrete design: **every AI function gets its own Medplum
Bot identity, and every Bot identity gets its own Access Policy**, scoped to
the resource types, date range, and patient compartment that function
specifically needs — enforced by Medplum's native ABAC (§10), not
application-code convention. §08.2's care-setting table already implies the
right shape (OPD scopes to a single Encounter; discharge summaries
legitimately scope to the full stay — the specifically-justified full-record
case §164.514(d)(5) allows); this should become an explicit, named,
per-function scope table, one row per AI function, each with its
justification written down. Every AI call's audit log entry (§09) should
record **which FHIR resources were actually assembled into that call's
context**, not only that a call happened — the artifact that makes
minimum-necessary demonstrable after the fact, and doubles as the
"clinician can independently review the basis for the recommendation"
evidence relevant to staying on the non-device side of the FDA boundary
(§09.1). This also reframes something already true but implicit: the
three-tier AI model above (local / self-hosted open-weight / frontier) is
itself the single most important BAA-and-minimum-necessary-reducing design
decision in the architecture, since every call staying in tiers 1–2 needs
zero BAA and has no external disclosure to scope at all — worth promoting to
a named compliance control in §09, not left implicit here. Separately:
HInS's self-hosted posture is a genuine HIPAA advantage, not just a privacy
one — because Medplum, Keycloak, and the custom services are the covered
entity's own systems rather than SaaS, "who is a business associate"
collapses to just the AI Gateway's *external* frontier calls, materially
shrinking the BAA surface versus a cloud-EHR-plus-bolt-on-AI architecture.

## 09 — Security architecture

| Control | Approach |
|---|---|
| Encryption | AES-256 at rest, tenant-scoped KMS keys; TLS 1.3 in transit |
| Authentication | MFA mandatory for every clinical/admin role; badge-tap/biometric fast re-auth on shared terminals |
| Authorization | RBAC (§10) overlaid with ABAC — scoped to patients actually being treated/covered |
| Emergency access | Break-glass override, fully logged, auto-opens 24-hour post-hoc review |
| Audit logging | Append-only, tamper-evident — every PHI read/write/export/AI call, tied to its consent record |
| Breach response | Parallel HIPAA (60-day) and DPDP (Data Protection Board) workflows, auto-routed by tenant compliance mode |
| Data residency | Per-tenant pinning — India tenants default in-country, US tenants to a US region |
| Session handling | Short idle timeout on shared clinical workstations; longer, re-authenticated sessions for admin desks |

**09.1 FDA SaMD boundary — where it will actually bite.** 21st Century Cures
Act §520(o)(1)(E) excludes "non-device" clinical decision support from FDA
regulation only if software (1) does not acquire, process, or analyze a
medical image, IVD signal, or signal-acquisition pattern; (2) only
displays/analyzes/prints medical information; (3) supports rather than
replaces a clinician's recommendation; and (4) lets the clinician
independently review the basis for that recommendation. **Criterion 1 is
unconditional — there is no "advisory only" exception for image or signal
analysis.** Any future AI feature reading a DICOM image or a waveform (an
imaging pre-read flag, an ECG anomaly detector — directly relevant to the
not-yet-built RIS/PACS module, §05/§13) is categorically outside the
non-device carve-out regardless of how clinician-reviewed it's designed to
be, and needs a real FDA pathway (510(k)/De Novo/PMA) chosen **before** it's
built, not discovered after. Text-only CDSS/ambient-documentation features
stay on the advisory, non-device side as long as criterion 4 holds in
practice — the direct regulatory argument, not just a quality one, for
keeping §08.3's groundedness check against source chart data as a hard
requirement, and for §08.4's per-call "what did it actually see" audit log.

## 10 — RBAC, ABAC & multi-tenant white-label

| Role | Scope |
|---|---|
| Patient | Own record (read), own consent grants, own appointments/billing |
| Treating physician | Full read/write on assigned patients, eRx, CDSS, voice scribe |
| Consulting physician | Read-only, time-boxed, only explicitly-referred patients |
| Nurse | Ward-scoped vitals/MAR read-write; no billing, no diagnosis edits |
| Lab technician | LIS orders/results for assigned specimens only |
| Radiologist | RIS/PACS and related orders; no billing |
| Pharmacist | eRx verification, logged interaction overrides; no clinical notes |
| Billing/RCM staff | Claims/billing, coded diagnoses only — no narrative notes |
| HR/payroll | ERP/HR module only — zero clinical data access |
| Research analyst | De-identified/aggregated data via admin-approved export (§11) only |
| Compliance/privacy officer | Audit logs, consent records, breach workflow — read-only on clinical data |
| Tenant admin | User/role management, module toggles, branding, AI config — no standing clinical access |
| Platform super-admin | Tenant provisioning, platform health — zero standing access to tenant PHI |

**Multi-tenancy & white-label.** Baseline isolation via row-level security on
`tenant_id` (Postgres RLS), with an upgrade path to schema- or database-per-
tenant for groups needing stronger separation. Custom domain, logo/theme,
module toggles, locale/language packs, AI provider/model choice, and
data-residency pin all live in tenant configuration — never forked code.

## 11 — API & data exposure strategy

FHIR R4 REST is the only sanctioned API surface. Third-party apps authenticate
via SMART on FHIR v2 (granular, search-parameter-scoped access; the server
records what was actually granted). Research/analytics access never touches
the live clinical DB directly — a tenant admin configures a **Data Exposure
Policy** (exportable resource types, de-identification method, required
purpose codes/consent types), and every export runs through FHIR Bulk
`$export` (including `Group/{id}/$export` for a research cohort) into the
de-identification pipeline before landing in the isolated research warehouse.
FHIR Subscriptions handle event-driven integration without polling.

## 12 — Non-functional requirements

| Dimension | Target |
|---|---|
| Availability | 99.9%+ for clinical-critical modules (OPD, ER, bed management); degraded/offline mode on ward devices |
| Disaster recovery | RPO ≤ 15 min, RTO ≤ 1 hour for the clinical database |
| Performance | p95 chart lookup under 300ms |
| Accessibility | WCAG 2.2 AA on the patient portal |
| Localization | English + Hindi + configurable regional languages per tenant, including voice-scribe language support |
| Scalability | Horizontal scaling per domain service; multi-tenant from day one |

## 12a — Required team & expertise

Everything built so far (consent-service, deid-service, audit-service,
`apps/web`, scheduling, the RBAC/Keycloak hardening) has been fullstack
engineering on the Fastify+Zod+Drizzle+Postgres+Medplum pattern, and the
swarm-build process (Decisions log, 2026-10-18) has shown that pattern scales
to parallel execution well. The gaps found across §03–§09 above need real
domain expertise an engineering team can't safely assume by default —
several (guardian-consent verification, research-consent sub-typing, the
breach-notification trigger, minimum-necessary AI scoping) are requirements
an engineering team can't correctly scope without a domain specialist naming
the requirement first, because it isn't in this document and isn't something
a generalist compliance search reliably surfaces.

| Role | Owns, on HInS specifically | When needed | Risk if missing |
|---|---|---|---|
| **Fullstack developer(s)** | Bed/ward management, pharmacy dispensing, inventory; continues the proven service pattern | Continuously, through Phase 02–03 | Growing module surface without proportional review discipline risks a repeat of the notification-bell regression at higher stakes (a billing double-charge, a bed double-assignment) |
| **Forward-Deployed Engineer (FDE)** | Embeds with the first *real* (non-reference) hospital tenant: maps its existing patient-ID scheme into Medplum, reconciles its real (likely inconsistent, partly-paper) data into FHIR, configures its Access Policies against its real org chart, owns the ABDM M1→M2→M3 sandbox-to-production certification specifically (hands-on, NHA-liaison-heavy work) | The moment a real hospital signs — not before | Without this role, go-live either stalls the roadmap while the core team context-switches into one-off firefighting, or customer hacks get hard-coded into shared services, breaking the multi-tenant isolation (§10) every *other* tenant depends on |
| **AI/ML engineer** | The self-hosted-Whisper migration (domain fine-tuning per care setting, §08.2 — stock Whisper's published 19–33% WER on clinical audio is characterized in the literature as "not suitable for unsupervised clinical use"), the groundedness checker (§08.3), terminology-grounded CDSS once §03.6/§03.7 are live | Now, for Whisper specifically (the most concretely numbers-backed open gap found); CDSS waits on medication coding | Shipping browser-`SpeechRecognition`→Whisper as a pure infra swap, with no per-setting WER validation, risks the exact "inpatient misattribution = patient-safety incident" scenario §08.2 already names |
| **Agentic-workflow/orchestration engineer** | Least-privilege tool-scoping, per-tool-call auditability, interruptibility, and the judgment that "human-in-the-loop" doesn't reduce risk if the reviewer can't actually exercise the checkpoint in the time they have | **Not yet, and that's a defensible answer** — §08.3's "no AI function places an order, signs a note, or commits on its own" keeps this role's risk surface inapplicable today. Activates the moment that principle is ever relaxed | Hiring too early is premature; not naming the trigger risks a future multi-step agent feature (drafting-and-queuing a lab order, a multi-step prior-auth) shipping with the same ad hoc prompt-chaining that works for a single-shot call |
| **DPDP compliance officer / incoming DPO** | SDF-readiness (DPIA cadence, independent-auditor relationship, algorithmic due-diligence over §08), the guardian/representative gap as an owned item, the research-warehouse Data Fiduciary question (§03.1) | Now, at least fractionally — the DPIA artifact and the guardian-consent fix are themselves engineering-blocking, and "DPO" is a named, India-resident role that can't be conjured retroactively on SDF notification | The guardian-consent gap ships into a real pediatric tenant with no one having flagged it as the Section 9 violation it concretely is — not hypothetical, pediatrics is already in the reference deployment |
| **HIPAA Security Officer & Privacy Officer** (one person, two titles) | The formal §164.308(a)(1) risk analysis (undocumented today), the BAA registry and its re-verification cadence, minimum-necessary sign-off on each new RBAC role, §08.4's per-function AI Access-Policy rollout | **Now — unconditionally, zero staging delay** | A real breach today has no documented risk-analysis trail to demonstrate reasonable diligence — the exact standard HIPAA enforcement hinges on |
| **Clinical informaticist / terminology specialist** | SNOMED CT India affiliate registration + CDCI drug-extension integration (§03.6), the US Core/USCDI crosswalk (§03.7), ABDM Composition "Record" bundle assembly (§03.8) — terminology-content knowledge plus FHIR profiling mechanics, a distinct skill from backend engineering | Now, to unblock medication coding specifically — a hard dependency for pharmacy and any drug-interaction CDSS | Medications stay free-text indefinitely by default/inertia rather than a deliberate roadmap decision, foreclosing an entire category of CDSS value without anyone making that trade-off explicitly |
| **Security/InfoSec engineer** | The HIPAA-proposed-bar controls (MFA, segmentation, scan/pen-test cadence) regardless of NPRM finalization, plus ABDM's WASA/Safe-to-Host security-audit coordination (a CERT-In/STQC-empanelled third-party audit, a named prerequisite for ABDM production credentials) | Alongside the FDE role, once ABDM production credentialing is in view | No one owns the WASA audit relationship, stalling ABDM production access even after the FHIR-profile work is done |
| **Interoperability/integration engineer (HL7v2/DICOM)** | HL7v2 segment-level parsing, DICOM conformance, legacy-instrument bridging for LIS/RIS-PACS | Phase 02 (Diagnostics) | "Fullstack developer" undersells how different HL7v2 interface work is from a Mantine form — understaffing this risks the most expensive single subsystem running long with the wrong skill mix |
| **Clinical Safety Officer** (clinically qualified) | A living Hazard Log + Clinical Safety Case across every future feature (the ward-rounds voice-misattribution risk, §08.2, is already written as exactly this kind of hazard-log entry, just not in that formal shape); a pre-go-live sign-off gate; each hospital tenant separately signing off on its own local configuration risk (the UK DCB0129/0160 two-tier pattern this role is modeled on — an analogy, not a claimed India/US legal requirement) | Before the first real patient encounter — a go-live gate | The next patient-safety-shaped risk (bed management, pharmacy dispensing, lab-result routing are all still ahead) has no standing process guaranteed to catch it, unlike the ward-rounds one which was caught only because someone happened to think it through |
| **RCM/billing & pharmacy domain SMEs** | US insurance-claims complexity (837/835 EDI, payer adjudication rules), controlled-substance dispensing regulations | Phase 02–03 | Both modules get built functionally but not correctly — a domain-correctness risk distinct from a code-quality one |
| **ABDM/NHCX integration specialist** | The Fidelius encryption scheme, gateway callback shape, NHCX's maturing adoption status (§03.8) | Once ABDM/NHCX moves from design to build | Generic FHIR competence doesn't cover ABDM-specific protocol mechanics — a specialization gap, not a staffing-level one |

**Tier 1 — minimum viable team (next 2–3 phases):** 2–3 fullstack developers
(full-time, swarm pattern already proven); a clinical informaticist
(fractional now, growing by Phase 02) to resolve SNOMED CT India/CDCI; a
HIPAA Security+Privacy Officer (fractional now, mandatory before any real
PHI); a DPDP compliance advisor/incoming DPO (fractional, advisory); an
AI/ML engineer (fractional-to-full-time, Whisper fine-tuning first).
Explicitly **not yet needed**: an FDE (no real hospital tenant yet), an
Agentic-Workflow Engineer (no multi-step, write-capable agent feature
exists), a dedicated Clinical Safety Officer hire (the informaticist can
wear that hat short-term, should become distinct before any real patient
encounter).

**Tier 2 — full team for the complete build:** everything in Tier 1, plus an
FDE (first real hospital signs); a dedicated Clinical Safety Officer (before
first real patient encounter); an Agentic-Workflow Engineer (the moment a
multi-step, write-capable AI feature is actually planned); a full-time,
India-resident DPO (on SDF notification, or proactively ahead of ~May 2027);
RCM/billing and pharmacy/drug-terminology specialists (Phase 02–03); an
HL7v2/DICOM interoperability specialist (Phase 02); an ABDM/NHCX integration
specialist.

**Open questions for the user:** Is Tier 1 staffable now, or does the
swarm/agent-based build pattern continue longer before human hires beyond
the fractional compliance/informaticist roles? When is the first real
hospital tenant realistically expected — the FDE hiring trigger? Can an
existing team member hold the named HIPAA Security/Privacy Officer titles
immediately (legally required today), or does this need an external hire
before any real PHI is handled? Is a clinically-qualified Clinical Safety
Officer recruitable via a hospital-partner secondment, or does this need a
standalone hire?

## 13 — Phased roadmap

Sequenced by dependency, not calendar. Subsystem detail, FHIR-resource
mapping, and the recommended build order's rationale are in §13a below —
this table is the summary.

| Phase | Focus | Depends on |
|---|---|---|
| 00 — Foundations | Identity/IAM, Consent Service, Terminology Service, Medplum FHIR core, audit logging, security baseline | — |
| 01 — Core clinical MVP | **Started 2026-10-15** — registration, OPD/encounter notes, e-prescribing, consent recording, and scheduling with practitioner double-booking detection are built and verified (`apps/web`) | Phase 00 |
| 01a — Bed/ward management | **Built and verified live, 2026-10-19** (Decisions log above) — `Encounter.location`-based admission/transfer/discharge, real-time census derived from Encounter (no parallel status table), `apps/web`'s `BedBoard.tsx` at `/beds`. Went with a direct `Encounter.location` overlap check (the second option §13a's own row below lists), not a per-bed `Schedule`/`slotCapacity` design — deliberately does not inherit from the existing practitioner-double-booking work. **Known gaps:** check-then-write isn't atomic (same class of limitation as Scheduling.tsx's own double-booking check); existing IPD note-Encounters aren't linked to the new admission Encounter; clinician-facing only, no patient-portal view | Phase 01 |
| 02 — Diagnostics | LIS and RIS/PACS via the integration engine — **gated on the AGPL/GPL legal review (§07/§16) resolving first**, since it determines which anchors (OpenELIS, Orthanc) are usable at all; the FDA SaMD boundary (§09.1) must be settled before any imaging-AI feature is added here, not after | Phase 01, AGPL review |
| 02a — Pharmacy dispensing | **Dispense/administration plumbing built and verified live, 2026-10-19** (Decisions log above) — `MedicationDispense` (pickup/ward-issue, one code path for both) + `MedicationAdministration` (`'completed'`/`'not-done'` dose events), `apps/web`'s `PharmacyDispense.tsx` rendered inline under each prescription in `PatientDetail.tsx`'s Prescriptions tab. **Real interaction/allergy checking remains gated on §03.6's medication-coding resolution, not attempted** — medications are still free text, so there's no coded concept to check. **Also still open:** real stock/fulfillment-count tracking (separate "Inventory" item, §13a row below); a distinct Pharmacist role (no RBAC mechanism exists yet — any signed-in Practitioner can dispense today) | Phase 01, §03.6 |
| 03 — Financial & admin | US-path RCM/billing **built and verified live, 2026-10-19** (Decisions log above) — `Coverage`→`ChargeItem`→`Claim`→`Invoice`/`PaymentReconciliation`, `apps/web`'s `Billing.tsx` at `/billing`. **Stops at "ready to submit" on purpose: no `ClaimResponse`, no Stedi/Candid Health vendor integration, no `CoverageEligibilityRequest`/`Response`, no real payment gateway** — all four are still open, see §13a's row below. India-path NHCX integration (externally-maturing dependency, §03.8) remains entirely unbuilt; ERP, HR, supply chain still to be built pragmatically as a bounded service rather than on FHIR's immature `InventoryItem` (§13a) | Phase 01 |
| 04 — AI-first layer | AI Gateway, ambient voice documentation (self-hosted Whisper, domain-tuned per §08.2 care setting), CDSS (gated on terminology-service + medication coding), guardrails — plus §08.4's per-function Access-Policy minimum-necessary redesign, built in, not bolted on after | Phase 01 clinical system working without AI first |
| 05 — Patient-facing & interop | Patient portal (SMART App Launch v2.2.0, not an unscoped aspiration, §03.7), telehealth, ABDM/ABHA integration **against the actual ABDM FHIR IG Composition profiles (§03.8)**, not a loosely-modeled consent artefact alone | Phase 01–02 |
| 06 — Analytics, research & scale | Research warehouse + export policy (distinguishing DPDP's Second-Schedule exemption from ICMR's separate ethics-committee regime, §03.1), IoMT ingestion, white-label hardening | Phase 03–05 |

### 13a — Hospital Management System: subsystem scope, FHIR mapping, build order

| Subsystem | FHIR mapping | Medplum-native today | Relative size | Primary risk |
|---|---|---|---|---|
| Bed/ward/inpatient | `Encounter` for the whole stay — `Encounter.location` is a *repeating* list, giving full location history; `Encounter.hospitalization.dischargeDisposition` for outcome | **Built, 2026-10-19** (Decisions log above) — `BedBoard.tsx`. Confirmed live that a `Location` on an `Appointment` does not reserve capacity, consistent with Medplum's own docs; went with the direct `Encounter.location` overlap check option listed here (not per-bed `Schedule`/`slotCapacity`) — client-side filters each candidate Encounter's matching `location` entry down to the currently-open one (no `period.end`), since the FHIR `location` search param alone only confirms the bed appears somewhere in the list, confirmed empirically against this instance before relying on it | Weeks | Patient-safety-adjacent correctness, not technical novelty — check-then-write race (two concurrent admits into the same bed) remains open, same class of gap as Scheduling.tsx's own double-booking check |
| Pharmacy dispensing | `MedicationRequest` (built) → `MedicationDispense` → `MedicationAdministration` | **Dispense/Administration built and verified live, 2026-10-19** (Decisions log above) — `PharmacyDispense.tsx`. One `MedicationDispense` code path covers both outpatient pickup and inpatient ward-stock issue, per FHIR's own documented dual use; `MedicationAdministration` supports both `'completed'` and `'not-done'` (skipped-dose-with-reason) events. `MedicationRequest.status` is never changed by this feature — a request can be dispensed/administered against repeatedly (refills/repeated doses), intentionally, since no real stock ledger exists yet. **Still open, deliberately:** real interaction/allergy checking (blocked on §03.6's medication-coding — no coded concept exists yet to check against), real stock/fulfillment-count tracking (this row's own next item, "Inventory/supply chain," below), a distinct Pharmacist role (no RBAC mechanism exists for it) | Weeks of plumbing — done; clinical value (interaction checking) still gated on §03.6 | Inherited from the unresolved medication-coding gap, not this subsystem's own design |
| LIS/RIS-PACS | `ServiceRequest` (order) → `DiagnosticReport` (result) → `Specimen`/`ImagingStudy` | Low — needs a real DICOM runtime plus, for labs, historically-HL7v2 instrument integration | Multi-month — the largest of the six | Real integration surface, **plus the AGPL-3.0 review (§07/§16) is now a hard gate, not a parallel track**, since it decides which anchors (OpenELIS/Orthanc) are usable at all |
| Billing/RCM (US) | `Coverage`→`CoverageEligibilityRequest/Response`→`ChargeItem`/`ChargeItemDefinition`→`Claim`/`ClaimResponse`→`PaymentReconciliation`→`Invoice`/`Account`; `Task.businessStatus` for work queues | **The internal, non-vendor half is built and verified live, 2026-10-19** (Decisions log above): `Coverage`, `ChargeItem` (manual `priceOverride`, no `ChargeItemDefinition` fee-schedule lookup), `Claim` (bundles billable ChargeItems, flips them `billed`), `Invoice`+`PaymentReconciliation` ("Record payment"), `Account` (lazy, per-patient ledger anchor). **Still open, deliberately, and said so in the UI itself, not only here:** `CoverageEligibilityRequest`/`Response` (no real-time eligibility check — Coverage is taken on faith), `ClaimResponse`/real adjudication (no payer or clearinghouse is ever contacted — a fabricated one would be a worse bug than none), the Stedi/Candid Health vendor integration itself (X12 837P submission, 277CA/835 responses — this is the piece that actually needs a vendor contract, not more data modeling), and a real payment gateway (today's "Record payment" only logs an already-collected payment, e.g. cash/card at the desk or a manually-entered remittance) | Weeks-to-a-couple-months for the vendor wiring specifically — the data-model half above is done | Vendor contracting, not data modeling |
| Billing/RCM + claims (India) | Same `Claim`/`Coverage`/`ExplanationOfBenefit` family, routed through NHCX (§03.8) instead of a US clearinghouse | None yet, but the shared FHIR layer is the same investment as the US path | A couple of months | External dependency on a still-maturing government platform; mandatory-vs-voluntary status disputed (§03.8) |
| Inventory/supply chain | `SupplyRequest`→`SupplyDelivery`→`InventoryItem` — all FHIR R5 Trial-Use, Maturity Level 1, with zero known production implementations of `InventoryItem` per HL7's own resource index | None — the FHIR-native option is itself unproven here, unlike every other subsystem above | Weeks if built pragmatically as a bounded Postgres-backed service (the consent/deid/audit-service pattern); longer if insisting on strict FHIR-native modeling against an immature standard | The standard's own immaturity, not workflow complexity |

**AI/automation value, per subsystem — specific, not generic:** bed/ward
length-of-stay forecasting is a genuine planning aid for staff, never an
auto-discharge/reassignment trigger (accuracy degrades sharply on
atypical stays in every study found). Pharmacy interaction/allergy checks at
dispense time (a second checkpoint distinct from prescribing time) stay
advisory, same as §05's existing CDSS design. Imaging-triage/worklist
prioritization is a mature, FDA-regulated category today (1,000+ FDA-cleared
AI radiology devices), always conditioned on a physician reading every
study — the AI reorders the queue, never replaces the read; no comparably
mature AI application exists for lab-result interpretation specifically, a
genuine finding of absence, not an oversight. Billing/RCM's most concretely
cited agentic application is denial-reason-driven appeal drafting and
prior-auth documentation assembly (a federal structured-denial-reason API
mandate takes effect Jan 1 2027) — every credible pattern **drafts or
assembles, never autonomously submits**; the submission decision and any
medical-necessity judgment stay human — describe this to users as a
staff-augmenting drafting pipeline, not "automated billing." Inventory
demand-forecasting is mature and lower-stakes (a bad reorder costs money, not
patient safety) — keep procurement sign-off human regardless.

**Recommended build order:** (1) bed/ward first — highest FHIR maturity,
builds directly on Encounter work already done, closes the most visible
"not actually a hospital system yet" gap for the least cost, provided the
capacity-reservation design is deliberately re-derived rather than assumed
inherited; (2) billing/RCM US path second — substantially a wiring/vendor
project already documented by Medplum, fast demonstrable value; (3)
pharmacy's data plumbing third, in parallel with resolving §03.6 — build the
Dispense/Administration chain now, treat real interaction-checking as
blocked on that terminology decision; (4) NHCX/India billing fourth — same
FHIR family as (2) but with real external-platform-maturity risk, better
attempted once the US pattern is proven and §03.8's mandatory-vs-voluntary
question is resolved; (5) inventory pragmatically alongside whichever of the
above is in flight; (6) LIS/RIS-PACS last — correctly the most expensive,
and the existing instinct to anchor it on unmodified third-party systems
(Orthanc/OHIF/OpenELIS, §05/§07) rather than build native is well-founded,
with the AGPL review now a hard prerequisite for this subsystem specifically.

**Open questions for the user:** does this build order hold, or does a
specific prospective hospital partner's own priorities override it (e.g. if
the actual first tenant most needs pharmacy or lab first)? Is the AGPL/GPL
legal review schedulable now, given it's now a hard gate on the single most
expensive subsystem? Should NHCX's onboarding mandate be confirmed with
NHA/IRDAI before committing a build-order slot to it? For inventory: the
pragmatic custom Postgres-backed service now (recommended), or hold out for
a stricter FHIR-native model as `InventoryItem` matures?

## 14 — Test & acceptance use cases

Starting set, one per major risk surface — expand per module as each phase is
built.

| ID | Case | Verifies |
|---|---|---|
| TC-01 | ABHA-linked registration | Creates an HIE-CM-discoverable care context within SLA |
| TC-02 | Consent revoke propagation | Grant → release → revoke → access blocked at every HIP that received data, confirmed and logged |
| TC-03 | Voice scribe end to end | Record with consent → redaction verified → clinician edits → sign-off commits FHIR resources → audio deleted per policy; inpatient variant verifies no cross-patient misattribution |
| TC-04 | RBAC negative test | Nurse role denied billing/financial data access, attempt logged |
| TC-05 | Break-glass access | ER physician emergency override logged, 24-hour review ticket auto-created |
| TC-06 | Cross-tenant isolation | No API call under any role on Tenant A reads/writes Tenant B's data |
| TC-07 | Research export de-identification | `Group/$export` blocked without valid purpose code + consent binding; output matches configured de-identification method |
| TC-08 | Breach notification routing | Simulated exposure triggers both HIPAA 60-day and DPDP Board workflows, routed by tenant compliance mode |
| TC-09 | AI provider fallback safety | Self-hosted model unavailable → no silent fallback to a frontier API outside configured BAA scope |
| TC-10 | White-label separation | Two tenants on shared infra render distinct branding/modules/language, zero data bleed |

## 15 — Risk register

| Risk | Impact | Mitigation |
|---|---|---|
| AGPL/GPL component forked without realizing SaaS use triggers disclosure | Legal/IP exposure | License gate in CI on dependency changes; legal review before any AGPL/GPL fork |
| PHI sent to a frontier AI provider with no BAA on file | Regulatory exposure, reportable breach | Redaction-by-default; BAA registry gates any external AI call (§08) |
| Consent revocation not propagated to every HIP in time | ABDM non-compliance | Propagation SLA with per-recipient tracked status (§04.3) |
| Cross-tenant data leakage in shared multi-tenant DB | Catastrophic trust/legal failure | RLS + per-tenant isolation tests in CI (TC-06); DB-per-tenant for high-risk tenants |
| Voice recording captured without logged consent | Privacy violation | Microphone access hard-blocked without a prior consent event (§08.1) |
| Bahmni's AGPL→MPL/MIT relicensing (proposed Nov 2025) stays unresolved | Procurement uncertainty | Track the OpenMRS/Bahmni community decision before committing Bahmni as a dependency |
| Dual-jurisdiction regulatory drift — HIPAA 2025 update still proposed, DPDP phased over 18 months | Compliance gaps as rules finalize | Configurable compliance mode (§03) + a named compliance calendar owner |
| AI feature crosses into FDA-regulated SaMD territory with no chosen pathway | Regulatory/enforcement exposure, feature recall | §09.1's criterion-1 gate (image/signal analysis), checked before any RIS/PACS AI work starts, not after |
| CDSS/AI feature uses a protected-class-correlated input with no documented bias evaluation | Section 1557 exposure (§03.4a), independent of HIPAA | A named bias-identification/mitigation step per AI function before it ships |
| AI function's chart-read scope wider than its actual need, with no enforced/logged boundary | Undemonstrable minimum-necessary (§08.4) even if actual access happened to be reasonable | Per-function Bot identity + Access Policy (§08.4), logged per-call resource-assembly audit trail |
| No named HIPAA Security Official / Privacy Official | Already-binding, unconditional HIPAA gap the moment real PHI touches the system | Name both roles (§12a) before any real PHI, not staged to a future phase |
| Pediatric/guardian consent not functionally distinct from the patient's own consent | DPDP Section 9/Rule 10 violation, live today, not a future deadline | Three-actor consent model (§04.4) — patient, verified guardian, pediatric assent |
| Medications stored as free text, no drug terminology wired up | No drug-interaction/allergy CDSS can run at all, for any prescription — not a degraded one | CDCI (India) / RxNorm (US) integration at `MedicationRequest.medicationCodeableConcept` (§03.6) |
| Bed-conflict prevention assumed to inherit from the practitioner-double-booking work | A `Location` on an `Appointment` doesn't reserve capacity (Medplum's own docs) — two patients could be assigned the same bed | Dedicated per-bed `Schedule`/`slotCapacity` design or direct `Encounter.location` overlap check (§13a), not reused Appointment logic |

## 16 — Open decisions

- **Launch market order** — India-first, US-first, or simultaneous. Decides
  which compliance stack (§03) is MVP-critical.
- **Hosting model** — platform-hosted multi-tenant cloud vs. hospital's own
  on-prem/VPC. Changes the data-residency design (§09).
- **Reference hospital scale** — confirm St. Jones's profile (§02) against a
  real target to size Phase 1 precisely.
- **Legal review** of §07's licensing table before any AGPL/GPL component is
  adopted, even unmodified.
- **Pre-approved AI providers** — which frontier vendors get a standing
  BAA/DPA template vs. case-by-case review per hospital.
- **Consent approval round trip (2026-10-18 — built, not fully closed):**
  a clinician-initiated request can now be created with
  `requiresApproval=true`, lands as `status='pending'`, and only moves to
  `granted`/`revoked` (denied) via the patient's own approve/deny action
  (Decisions log above). Both endpoints now also verify the caller is
  actually that patient (2026-10-18 update, Decisions log above) — the
  "anyone with the consent id can approve/deny it" gap this bullet used
  to describe is closed. **Still open:** this models the mechanics of
  the round trip, not real ABDM HIP/HIU integration — there's no actual
  consent-manager app involved, and legal representative/guardian
  approval isn't modeled (only the patient's own resolved Medplum
  identity is ever accepted). Still needs the bigger design pass: does
  HInS build a reference PHR/consent-manager app, or only implement the
  HIP/HIU side and integrate with an existing one?
- **deid-service/audit-service RBAC hardening (2026-10-18, substantially
  closed):** `deid-service`'s `GET /audit`, `audit-service`'s `GET`/
  `POST /subscriptions`, `GET /notifications`, and (as of the same day's
  second update) `POST /notifications/:id/read`/`/read-all` are all
  gated — each verifies the caller is a real Medplum user on this
  project (via Medplum's own `GET /auth/me`, not local JWT decoding —
  see `services/audit-service/src/index.ts`'s `resolveCaller` header
  comment for what was tried against the live instance and why) and,
  for the admin-only ones, that the caller holds an active role. **The
  role source of truth is now a real Keycloak realm** (`hins-dev`), not
  the hand-seeded `alert_subscriptions` table (2026-10-18 update,
  Decisions log above) — closing what this bullet used to call out as
  the biggest remaining piece ("roles come from a trustworthy,
  centrally-managed source"). `deid-service` also now authenticates to
  Medplum itself via a real `client_credentials` service identity
  rather than the shared admin dev login (Decisions log, 2026-10-18).
  **Still open, not hidden:** Medplum and Keycloak are *not federated*
  — no SSO, practitioners/patients still log into Medplum directly, and
  provisioning a practitioner into Keycloak is a separate manual/seed
  step from their Medplum account existing. Token validation (WHO is
  calling) is still a live call to Medplum's `/auth/me` per request
  (correct, adds latency) rather than local JWKS verification. The
  frontend regression the first round of this hardening caused
  (`apps/web`'s notification bell 401ing because `auditApi.ts` sent no
  Authorization header) was caught before merge and fixed same-day
  (Decisions log above) — not a remaining item.
- **"Fully EHR/EMR"** — scheduling is now built (Decisions log above,
  FHIR `Appointment` via `@medplum/core`), including practitioner
  double-booking detection (Decisions log above) — scoped to
  practitioner-conflict only; same-PATIENT double-booking (one patient
  booked into two overlapping slots with different practitioners) is
  still not checked. **Bed/ward management is now built too** (Decisions
  log above, 2026-10-19 — `Encounter.location`-based admission/transfer/
  discharge, `BedBoard.tsx`, verified live including the adversarial
  double-admit-into-the-same-bed case). Its own known gaps: the
  occupancy check-then-write isn't atomic (same class of limitation as
  the scheduling double-booking check above); existing IPD note-Encounters
  from `PatientDetail.tsx` are not linked to the new, separate admission
  Encounter; no patient-portal view of the bed census. Full order
  workflows beyond notes/eRx are still unbuilt Phase 01 items (§13).
- **Editable `MedicationRequest`** — notes got full edit + version
  history (§05, Decisions log above); prescriptions didn't. Same pattern
  would extend cleanly, just not wired up yet.
- **Voice-to-text production path** — swap the dev-only browser
  `SpeechRecognition` dictation for a self-hosted Whisper call behind the
  AI Gateway, per §08's actual design, before any real patient data goes
  near it. Needs per-care-setting fine-tuning + WER validation before
  trusting it unsupervised (§12a) — stock Whisper's clinical-audio WER is
  characterized in the literature as "not suitable for unsupervised
  clinical use."
- **DPDP's SDF/breach/children/cross-border mechanics (2026-10-19 research
  round, §03.1)** are not yet modeled as distinct from the general
  compliance-mode toggle: (a) breach notification needs a detect-and-
  notify-always India path that can legitimately diverge from a
  risk-assessed US path for the *same* incident — TC-08 should assert this
  divergence is correct, not a bug; (b) the pediatric guardian/assent
  actor types (§04.4) are a live gap, not staged; (c) research consent
  needs ICMR sub-typing (§04.1).
- **Who is the Data Fiduciary for the cross-tenant research warehouse —
  HInS, or each contributing hospital?** (§03.1, §11) Not resolved; affects
  who owes the DPO/breach/grievance obligations for that data flow. Needs
  a real legal opinion, not an engineering decision.
- **DPDP's Second Schedule text (research exemption, Rule 16) has not
  been retrieved/verified against the primary Gazette document** —
  deid-service's architecture is directionally aligned but not confirmed
  sufficient as a DPDP legal matter specifically (§03.1).
- **HIPAA Expert Determination de-identification (§164.514(b)(1)) is
  unimplemented** — a process/role gap (a qualified statistician's
  engagement per release), not a code gap. Would unlock research exports
  with real statistical utility (exact ages, fine geography) that Safe
  Harbor's mandatory suppression currently destroys.
- **Limited Data Set's missing Data Use Agreement** — §164.514(e)(1) makes
  a signed DUA a legal precondition, not a best practice. Needs a
  DUA-tracking workflow, not a deid-service code change.
- **Is the "BAA registry gates any external AI call" claim (§08/§15) a
  built, enforced mechanism, or still only a documented intention?** TC-09
  should be checked for whether it actually verifies BAA-gating, not only
  model-availability fallback.
- **SNOMED CT India / CDCI affiliate-license registration (§03.6)** —
  free and administrative, days-to-weeks, not yet started. Separately,
  whether a hospital tenant deploying HInS commercially in India needs its
  own MLDS sublicense (distinct from HInS's own affiliate registration)
  is unresolved — needs counsel or a direct check with NRCeS.
- **ABDM M1→M2→M3 sandbox-to-production certification, and the WASA/
  Safe-to-Host security audit it requires (§12a, §03.8)** — not started;
  natural owner is the FDE role once a real hospital tenant is in view.
- **NHCX onboarding — mandatory (IRDAI) or voluntary-but-encouraged?**
  (§03.8) Sources disagree; resolve before committing a build-order slot
  to it (§13a).
- **The AGPL/GPL licensing review (§07) is now a hard gate, not a parallel
  track, on the LIS/RIS-PACS subsystem specifically (§13a)** — it decides
  which anchors (OpenELIS, Orthanc) are legally usable at all before any
  of that subsystem's engineering starts.
- **US Core 6.1.0 / USCDI v3 conformance (§03.7)** — HInS's FHIR usage is
  FHIR-*shaped* but not yet US-Core-*conformant*; and the ABDM FHIR
  Implementation Guide's seven Composition "Record" bundles (§03.8) are
  not yet assembled anywhere in `apps/web`. Both are the literal,
  resource-level gap between "uses FHIR" and "actually interoperates."

## 17 — References

Full source list (30 links — DPDP/ABDM/ICMR/HIPAA primary and secondary
sources, licensing pages for every §07 component) is maintained in the
published artifact: https://claude.ai/artifact/3NRZUR3SC5GoVQi3K1jWSw

---

*v0.2 draft — a research synthesis to seed engineering, compliance, and legal
review, not a finished specification. §03 and §07 especially should be
confirmed against primary sources and counsel before implementation decisions
depend on them.*
