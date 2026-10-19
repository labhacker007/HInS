import { Hl7Message, parseHl7DateTime } from '@medplum/core';
import type { CodeableConcept, Observation, ObservationReferenceRange, Quantity } from '@medplum/fhirtypes';

/**
 * HL7 v2 ORU^R01 (unsolicited observation result) -> FHIR Observations.
 * Segment/field parsing is @medplum/core's `Hl7Message` (Apache-2.0, already
 * a dependency); this file is only the OBX -> Observation mapping, written
 * from HL7 v2.5 chapter 7 (OBX field definitions, tables 0078/0085).
 *
 * Mapping (OBX field -> Observation):
 *   OBX-2 value type  NM -> valueQuantity; SN -> valueQuantity w/ comparator
 *                     (or valueString for ranges like "^10^-^20");
 *                     CE/CWE -> valueCodeableConcept; ST/TX/FT/others -> valueString
 *   OBX-3 identifier  code^text^system — a coding is emitted ONLY when the
 *                     system is "LN" (LOINC). Local lab codes are kept in
 *                     `code.text` and never dressed up as a coded system.
 *   OBX-5 value, OBX-6 units (UCUM system only when OBX-6.3 says "UCUM"),
 *   OBX-7 reference range ("low-high", "<x", ">x" parsed; otherwise text),
 *   OBX-8 abnormal flags -> interpretation (HL7 v3 ObservationInterpretation —
 *                     the v2 table 0078 codes L/H/LL/HH/N/A/AA/</>/S/R/I are
 *                     the same codes in that published code system),
 *   OBX-11 result status: X -> 'cancelled', D -> dropped (with a warning);
 *                     everything else is written as 'preliminary' because a
 *                     pathologist must still sign the report off in HInS —
 *                     the sending lab's own F/C status is kept in a note.
 *   OBX-14 observation time -> effectiveDateTime.
 *
 * Known gap, stated plainly: HL7 timestamps without an explicit offset are
 * interpreted in the BROWSER's local timezone (assumed to be the hospital's).
 * OBX-4 sub-IDs (grouping micro/sensitivity results) are not modelled;
 * NTE comments are folded into the report note only. Multiple OBR groups in
 * one message are flattened into one report (all OBX under the first OBR's
 * test name). There is no MLLP listener — this is upload-a-message only.
 */

export interface ParsedOru {
  messageControlId?: string;
  sendingFacility?: string;
  patientIdentifiers: string[]; // PID-3 values, for an identity cross-check against the order's patient
  patientName?: string;
  placerOrderNumber?: string; // OBR-2
  fillerOrderNumber?: string; // OBR-3
  reportCode?: CodeableConcept; // OBR-4
  observations: Observation[]; // no subject/basedOn yet — filled at import time
  notes: string[];
  warnings: string[];
}

const LOINC = 'http://loinc.org';
const V3_INTERP = 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation';
const INTERP_DISPLAY: Record<string, string> = {
  L: 'Low',
  H: 'High',
  LL: 'Critical low',
  HH: 'Critical high',
  N: 'Normal',
  A: 'Abnormal',
  AA: 'Critical abnormal',
  '<': 'Off scale low',
  '>': 'Off scale high',
  S: 'Susceptible',
  R: 'Resistant',
  I: 'Intermediate',
};
/** Interpretation codes rendered as "abnormal" (highlighted) in the UI. */
export const ABNORMAL_FLAGS = new Set(['L', 'H', 'LL', 'HH', 'A', 'AA', '<', '>', 'R', 'HU', 'LU']);

function localTzOffset(): string {
  const m = -new Date().getTimezoneOffset();
  const sign = m >= 0 ? '+' : '-';
  const a = Math.abs(m);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}${String(a % 60).padStart(2, '0')}`;
}

function hl7Time(ts: string | undefined): string | undefined {
  if (!ts || !/^\d{8}/.test(ts)) return undefined;
  if (ts.length === 8) return `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
  try {
    return parseHl7DateTime(ts, { tzOffset: localTzOffset() });
  } catch {
    return undefined;
  }
}

function codeFromCe(id: string, text: string, system: string): CodeableConcept | undefined {
  if (!id && !text) return undefined;
  if (system === 'LN' && id) return { coding: [{ system: LOINC, code: id, display: text || undefined }], text: text || id };
  return { text: text && id ? `${text} (local code ${id})` : text || id };
}

function parseRange(raw: string, unitQ: Partial<Quantity>): ObservationReferenceRange | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  const num = '(-?\\d+(?:\\.\\d+)?)';
  let m = new RegExp(`^${num}\\s*-\\s*${num}$`).exec(s);
  if (m) return { low: { ...unitQ, value: Number(m[1]) }, high: { ...unitQ, value: Number(m[2]) }, text: s };
  m = new RegExp(`^<=?\\s*${num}$`).exec(s);
  if (m) return { high: { ...unitQ, value: Number(m[1]) }, text: s };
  m = new RegExp(`^>=?\\s*${num}$`).exec(s);
  if (m) return { low: { ...unitQ, value: Number(m[1]) }, text: s };
  return { text: s };
}

export function parseOru(text: string): ParsedOru {
  // Accept \n / \r\n line endings from a text box or file; HL7 uses \r.
  const normalized = text.trim().replace(/\r\n|\n/g, '\r');
  if (!normalized.startsWith('MSH')) throw new Error('Not an HL7 v2 message: must start with an MSH segment.');
  const msg = Hl7Message.parse(normalized);
  const msh = msg.header;
  const type = `${msh.getComponent(9, 1)}^${msh.getComponent(9, 2)}`;
  if (type !== 'ORU^R01') throw new Error(`Expected an ORU^R01 message, got ${type || '(no MSH-9)'}.`);

  const pid = msg.getSegment('PID');
  const obr = msg.getSegment('OBR');
  const out: ParsedOru = {
    messageControlId: msh.getField(10)?.toString() || undefined,
    sendingFacility: msh.getComponent(4, 1) || undefined,
    patientIdentifiers: [],
    observations: [],
    notes: [],
    warnings: [],
  };
  if (pid) {
    const f = pid.getField(3);
    for (let r = 0; r < (f?.components.length ?? 0); r++) {
      const v = f.getComponent(1, undefined, r);
      if (v) out.patientIdentifiers.push(v);
    }
    out.patientName = [pid.getComponent(5, 2), pid.getComponent(5, 1)].filter(Boolean).join(' ') || undefined;
  } else {
    out.warnings.push('No PID segment — patient identity cannot be cross-checked against the order.');
  }
  if (obr) {
    out.placerOrderNumber = obr.getComponent(2, 1) || undefined;
    out.fillerOrderNumber = obr.getComponent(3, 1) || undefined;
    out.reportCode = codeFromCe(obr.getComponent(4, 1), obr.getComponent(4, 2), obr.getComponent(4, 3));
  }
  if (msg.getAllSegments('OBR').length > 1) {
    out.warnings.push('Message has more than one OBR — all OBX results are filed under one report.');
  }
  for (const nte of msg.getAllSegments('NTE')) {
    const c = nte.getField(3)?.toString();
    if (c) out.notes.push(c);
  }

  for (const obx of msg.getAllSegments('OBX')) {
    const setId = obx.getComponent(1, 1) || String(out.observations.length + 1);
    const vt = obx.getComponent(2, 1);
    const code = codeFromCe(obx.getComponent(3, 1), obx.getComponent(3, 2), obx.getComponent(3, 3));
    const status = obx.getComponent(11, 1);
    if (!code) {
      out.warnings.push(`OBX-${setId}: no observation identifier (OBX-3) — skipped.`);
      continue;
    }
    if (status === 'D') {
      out.warnings.push(`OBX-${setId} (${code.text}): sender marked it "delete" (D) — skipped.`);
      continue;
    }
    const unitId = obx.getComponent(6, 1);
    const unitText = obx.getComponent(6, 2);
    const unitSystem = obx.getComponent(6, 3);
    const unitQ: Partial<Quantity> = unitId || unitText ? { unit: unitText || unitId } : {};
    if (unitId && /^UCUM$/i.test(unitSystem)) Object.assign(unitQ, { system: 'http://unitsofmeasure.org', code: unitId });

    const obs: Observation = {
      resourceType: 'Observation',
      status: status === 'X' ? 'cancelled' : 'preliminary',
      category: [
        {
          coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory', display: 'Laboratory' }],
        },
      ],
      code,
      effectiveDateTime: hl7Time(obx.getComponent(14, 1)) ?? hl7Time(obr?.getComponent(7, 1)),
      note: status ? [{ text: `Sending lab result status (OBX-11): ${status}` }] : undefined,
    };

    const raw = obx.getField(5)?.toString() ?? '';
    if (status !== 'X') {
      if (vt === 'NM') {
        const n = Number(raw.trim());
        if (raw.trim() !== '' && Number.isFinite(n)) obs.valueQuantity = { ...unitQ, value: n };
        else {
          obs.valueString = raw;
          out.warnings.push(`OBX-${setId} (${code.text}): NM value "${raw}" is not numeric — stored as text.`);
        }
      } else if (vt === 'SN') {
        const [cmp, n1, sep, n2] = [1, 2, 3, 4].map((i) => obx.getComponent(5, i));
        if (!sep && n1 && Number.isFinite(Number(n1))) {
          const comparator = ['<', '<=', '>', '>='].includes(cmp) ? (cmp as Quantity['comparator']) : undefined;
          obs.valueQuantity = { ...unitQ, value: Number(n1), comparator };
        } else {
          obs.valueString = [cmp, n1, sep, n2].filter(Boolean).join(' ');
        }
      } else if (vt === 'CE' || vt === 'CWE') {
        const cc = codeFromCe(obx.getComponent(5, 1), obx.getComponent(5, 2), obx.getComponent(5, 3));
        if (cc) obs.valueCodeableConcept = cc;
      } else if (raw) {
        // ST / TX / FT and anything else: keep as text (HL7 escape sequences left as-is).
        obs.valueString = raw.replace(/\\\.br\\/g, '\n');
      }
    }

    const range = parseRange(obx.getField(7)?.toString() ?? '', unitQ);
    if (range) obs.referenceRange = [range];

    const flag = obx.getComponent(8, 1);
    if (flag) {
      obs.interpretation = [
        INTERP_DISPLAY[flag]
          ? { coding: [{ system: V3_INTERP, code: flag, display: INTERP_DISPLAY[flag] }], text: INTERP_DISPLAY[flag] }
          : { text: `Abnormal flag ${flag}` },
      ];
    }
    out.observations.push(obs);
  }
  if (out.observations.length === 0) throw new Error('ORU^R01 message has no usable OBX results.');
  return out;
}
