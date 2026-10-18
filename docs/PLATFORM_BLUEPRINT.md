# HInS Platform Blueprint

**Project Development & Requirements Document · v0.7**
Status: Draft — decisions in progress · Scope: India + US, dual-jurisdiction · Last updated: 2026-10-15

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

| 2026-10-18 | **deid-service + audit-service RBAC hardening**: `GET /audit` (deid-service), `GET`/`POST /subscriptions` and `GET /notifications` (audit-service) are no longer unauthenticated | Researched against the live Medplum instance before implementing (not guessed): `GET /oauth2/userinfo` only returns the User id, not the Practitioner id this needed; forwarding the caller's own token to `GET /fhir/R4/Practitioner/{claimedId}` and checking it returns 200 was tried and found **insecure** on this instance — this project's default Practitioner Access Policy lets any authenticated practitioner read any *other* Practitioner record too, so a claimed id isn't provable that way (verified: Dr. Sharma's real token successfully read Medplum Admin's Practitioner record). What works and isn't spoofable: Medplum's own `GET /auth/me`, which resolves the caller's Practitioner from the token's session server-side with no claimed id involved. Role check reuses `audit-service`'s existing `alert_subscriptions` table directly (role IN `tenant_admin`/`compliance_officer`) rather than a second role table. `GET /notifications` additionally checks the resolved caller's own id matches the requested `recipientId` unless they hold an admin role. Verified end-to-end with real tokens (admin@example.com and dr.sharma@stjones.example, who is seeded but deliberately not in `alert_subscriptions`): every gated endpoint correctly 401s with no token, 403s for Dr. Sharma, and 200s for admin. **Still open, stated in both services' READMEs and §16:** role source of truth is still the hand-seeded table, not real Keycloak RBAC; token validation is a live per-request call to Medplum, not local JWT verification. |

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
| DPDP Act 2023 + Rules 2025 | India | All personal data processing | Granular, revocable, purpose-bound consent; interoperable Consent Manager support; Data Protection Board breach notice; 18-month phased compliance window |
| ABDM — ABHA, HIE-CM | India | Cross-facility health data exchange | FHIR R4 bundles; HIP/HIU roles; signed per-source consent artefacts; no central repository (§04) |
| ICMR National Ethical Guidelines (2017) | India | Human-participant research | Ethics-committee-approved informed consent; broad-consent & waiver handling; child assent |
| HIPAA — Privacy, Security, Breach Notification | United States | PHI at covered entities/business associates | Minimum-necessary access; encryption at rest/in transit; 60-day breach notice; signed BAA with every PHI-touching vendor, AI providers included |
| SNOMED CT · LOINC · ICD-10/11 · HL7v2 · FHIR R4 · DICOM | Global · India via NRCeS | Clinical terminology & interoperability | FHIR R4 as the API backbone; coded, not free-text, problems/labs/orders wherever a terminology exists |

**03.1 India — DPDP Act & Rules.** Consent must be free, specific, informed,
revocable, one notice per purpose. The "essential services" carve-out for
hospitals applies only once government-notified — don't assume it by default.
Research processing has its own exemption under the Rules' Second Schedule,
conditional on not being used to make decisions about the individual.

**03.2 India — ABDM consent model.** Federated by design: records stay at the
originating HIP and move only via a signed consent artefact scoped to a
specific HIU, purpose, and time window. No central repository to protect or
leak.

**03.3 India — ICMR research ethics.** Any research/analytics data path (§11)
sits downstream of ICMR's consent rules — written, ethics-committee-approved,
with broad consent, waiver-by-committee, and child assent as distinct,
trackable types.

**03.4 United States — HIPAA.** *Status check:* HHS's proposed Security Rule
update (NPRM, Jan 2025) was still proposed, not final, as of the March 2025
comment close — verify current status. Build to the proposed bar anyway:
encryption at rest/in transit, mandatory MFA, network segmentation, annual
asset inventory, biannual vulnerability scans, annual pen tests, access revoked
within 1 hour of termination, DR restoring service within 72 hours. Every
business associate needs written, annually-reverified safeguard verification.

**03.5 Terminology & interoperability.** India is a SNOMED International
member (since March 2014) — free use, but still requires an affiliate license
via NRCeS/C-DAC Pune. LOINC is free worldwide. India's 2016 MoHFW EHR
standards recommend SNOMED CT, an ICD edition, LOINC, and NDC-equivalent drug
coding — sources disagreed on ICD-10 vs. ICD-11; confirm against the current
MoHFW document before locking the terminology service's default code system.

> **Not legal advice.** §03 synthesizes public secondary sources, several
> explicitly flagging conflicting/unconfirmed details. Treat it as a briefing
> for counsel, not a substitute — especially the essential-services exemption,
> the research exemption's conditions, and the ICD-10/11 call.

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
| `grantor` | Patient, or guardian/LAR for minors and persons with disabilities |
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
representative grantor type, not a workaround on the patient's account. A
separate break-glass path (§09) allows emergency access without prior
consent — logged, time-boxed, mandatory 24-hour post-hoc review.

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

## 13 — Phased roadmap

Sequenced by dependency, not calendar.

| Phase | Focus | Depends on |
|---|---|---|
| 00 — Foundations | Identity/IAM, Consent Service, Terminology Service, Medplum FHIR core, audit logging, security baseline | — |
| 01 — Core clinical MVP | **Started 2026-10-15** — registration, OPD/encounter notes, e-prescribing, and consent recording are built and verified (`apps/web`). Not yet: scheduling, bed management, inpatient-specific workflow beyond note-taking | Phase 00 |
| 02 — Diagnostics | LIS and RIS/PACS via the integration engine | Phase 01 |
| 03 — Financial & admin | RCM/billing, ERP, HR, supply chain | Phase 01 |
| 04 — AI-first layer | AI Gateway, ambient voice documentation, CDSS, guardrails | Phase 01 clinical system working without AI first |
| 05 — Patient-facing & interop | Patient portal, telehealth, ABDM/ABHA integration, SMART on FHIR ecosystem | Phase 01–02 |
| 06 — Analytics, research & scale | Research warehouse + export policy, IoMT ingestion, white-label hardening | Phase 03–05 |

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
- **Consent approval round trip** — the MVP's consent actions (§05) write a
  grant immediately; a real ABDM flow needs the request to go to the
  patient's own consent-manager app and wait for approval (§04.2) before
  any grant is recorded. Needs a design pass: does HInS build a reference
  PHR/consent-manager app, or only implement the HIP/HIU side and integrate
  with an existing one?
- **deid-service/audit-service RBAC hardening (2026-10-18 update —
  partially closed, not fully):** `deid-service`'s `GET /audit`, and
  `audit-service`'s `GET`/`POST /subscriptions` and `GET /notifications`,
  are no longer unauthenticated — each now verifies the caller is a real
  Medplum user on this project (via Medplum's own `GET /auth/me`, not
  local JWT decoding — see `services/audit-service/src/index.ts`'s
  `resolveCaller` header comment for what was tried against the live
  instance and why) and, for the admin-only ones, that the caller has an
  active `alert_subscriptions` row with role `tenant_admin` or
  `compliance_officer` (§10.1). `GET /notifications` additionally
  confirms a non-admin caller's own id matches the `recipientId` they're
  requesting. **Still open, not hidden:** the role source of truth is
  still that same hand-seeded `alert_subscriptions` table, not a real
  Keycloak-integrated RBAC system — this closes "nobody checks who's
  calling," not "roles come from a trustworthy, centrally-managed
  source." Token validation is a live call to Medplum per request
  (correct, adds latency) rather than local JWKS verification.
  `audit-service`'s `POST /notifications/:id/read` and
  `/notifications/read-all` remain ungated. The service also
  authenticates to Medplum with the admin dev login rather than a proper
  `client_credentials` service identity (`services/deid-service/src/medplumClient.ts`'s
  header has the detail) — same underlying gap as the rest of this
  list's "real service accounts, not shared human logins" theme, and
  separate from the caller-authentication work above.
- **"Fully EHR/EMR"** — explicitly not attempted in this round, said
  plainly rather than implied done: scheduling, bed/ward management, and
  full order workflows (beyond notes/eRx) are still unbuilt Phase 01
  items (§13). What this round added was depth on what already existed —
  edit/version history and voice dictation on the clinical documentation
  flow — not new breadth.
- **Editable `MedicationRequest`** — notes got full edit + version
  history (§05, Decisions log above); prescriptions didn't. Same pattern
  would extend cleanly, just not wired up yet.
- **Voice-to-text production path** — swap the dev-only browser
  `SpeechRecognition` dictation for a self-hosted Whisper call behind the
  AI Gateway, per §08's actual design, before any real patient data goes
  near it.

## 17 — References

Full source list (30 links — DPDP/ABDM/ICMR/HIPAA primary and secondary
sources, licensing pages for every §07 component) is maintained in the
published artifact: https://claude.ai/artifact/3NRZUR3SC5GoVQi3K1jWSw

---

*v0.2 draft — a research synthesis to seed engineering, compliance, and legal
review, not a finished specification. §03 and §07 especially should be
confirmed against primary sources and counsel before implementation decisions
depend on them.*
