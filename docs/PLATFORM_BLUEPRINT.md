# HInS Platform Blueprint

**Project Development & Requirements Document · v0.2**
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
   Config/White-label.
4. **Core Clinical Engine** — Medplum FHIR datastore (HIS/EMR/EHR).
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
| 01 — Core clinical MVP | Registration, scheduling, bed management, OPD workflow, basic EMR, e-prescribing | Phase 00 |
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

## 17 — References

Full source list (30 links — DPDP/ABDM/ICMR/HIPAA primary and secondary
sources, licensing pages for every §07 component) is maintained in the
published artifact: https://claude.ai/artifact/3NRZUR3SC5GoVQi3K1jWSw

---

*v0.2 draft — a research synthesis to seed engineering, compliance, and legal
review, not a finished specification. §03 and §07 especially should be
confirmed against primary sources and counsel before implementation decisions
depend on them.*
