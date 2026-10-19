/**
 * Minimal DICOM Part 10 header reader — just enough tags to build a FHIR
 * `ImagingStudy` (StudyInstanceUID, SeriesInstanceUID, SOPInstanceUID,
 * SOPClassUID, Modality, StudyDate, descriptions, PatientID/Name for an
 * identity cross-check). Written from the DICOM standard (PS3.5 data
 * encoding, PS3.10 file format) — no third-party code copied, no new npm
 * dependency. dcmjs (MIT) was considered and rejected for this track: it is
 * a large dependency to pull in for ~a dozen header tags, and the viewer
 * (OHIF, MIT) that would actually benefit from a full DICOM toolkit is a
 * separate, later piece of work.
 *
 * Supported transfer syntaxes for the dataset: Explicit VR Little Endian
 * (1.2.840.10008.1.2.1), Implicit VR Little Endian (1.2.840.10008.1.2), and
 * any compressed syntax that is encoded as Explicit VR LE (JPEG, JPEG 2000,
 * RLE — all of PS3.5's "encapsulated" syntaxes keep the header explicit LE;
 * we stop before Pixel Data so the compression itself never matters).
 *
 * Known gap, stated plainly: Explicit VR Big Endian (retired) and Deflated
 * Explicit VR LE (1.2.840.10008.1.2.1.99) are NOT parsed — the reader
 * returns `supported: false` and the UI falls back to manual entry of the
 * StudyInstanceUID/modality/date. Files without the 128-byte preamble +
 * "DICM" magic (raw pre-Part-10 datasets) are rejected the same way.
 * Character sets other than ASCII/Latin-1 (SpecificCharacterSet) are
 * decoded as Latin-1, which can garble non-Latin patient names; the name is
 * only used for an on-screen cross-check, never written to FHIR.
 */

export interface DicomHeader {
  supported: boolean;
  reason?: string;
  transferSyntaxUid?: string;
  studyInstanceUid?: string;
  seriesInstanceUid?: string;
  sopInstanceUid?: string;
  sopClassUid?: string;
  modality?: string;
  studyDate?: string; // DICOM DA, YYYYMMDD
  studyTime?: string;
  studyDescription?: string;
  seriesDescription?: string;
  seriesNumber?: string;
  instanceNumber?: string;
  bodyPartExamined?: string;
  patientId?: string;
  patientName?: string;
  accessionNumber?: string;
}

const TAGS: Record<string, keyof DicomHeader> = {
  '00020010': 'transferSyntaxUid',
  '00080016': 'sopClassUid',
  '00080018': 'sopInstanceUid',
  '00080020': 'studyDate',
  '00080030': 'studyTime',
  '00080050': 'accessionNumber',
  '00080060': 'modality',
  '00081030': 'studyDescription',
  '0008103E': 'seriesDescription',
  '00100010': 'patientName',
  '00100020': 'patientId',
  '00180015': 'bodyPartExamined',
  '0020000D': 'studyInstanceUid',
  '0020000E': 'seriesInstanceUid',
  '00200011': 'seriesNumber',
  '00200013': 'instanceNumber',
};

/** VRs whose explicit-VR encoding uses 2 reserved bytes + a 4-byte length. */
const LONG_VRS = new Set(['OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'SQ', 'SV', 'UC', 'UN', 'UR', 'UT', 'UV']);
const UNDEFINED = 0xffffffff;

const hex4 = (n: number) => n.toString(16).toUpperCase().padStart(4, '0');

function decodeText(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  // DICOM pads strings with trailing space (or NUL for UIs).
  return s.replace(/[\0\s]+$/, '').replace(/^\s+/, '');
}

export function parseDicomHeader(buffer: ArrayBuffer): DicomHeader {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 132 || decodeText(bytes.subarray(128, 132)) !== 'DICM') {
    return { supported: false, reason: 'Not a DICOM Part 10 file (missing 128-byte preamble + "DICM" marker).' };
  }
  const out: DicomHeader = { supported: true };

  // Returns the offset just past the element, or -1 to stop.
  function readElements(start: number, end: number, explicit: boolean, stopAtPixel: boolean, depth: number): number {
    let off = start;
    while (off + 8 <= end) {
      const group = view.getUint16(off, true);
      const element = view.getUint16(off + 2, true);
      const tag = hex4(group) + hex4(element);
      // Item / delimitation tags (FFFE,xxxx) are always implicit-style: tag + 4-byte length.
      if (group === 0xfffe) {
        const len = view.getUint32(off + 4, true);
        if (element === 0xe0dd || element === 0xe00d) return off + 8; // sequence / item delimiter
        off += 8 + (len === UNDEFINED ? 0 : len);
        continue;
      }
      if (stopAtPixel && group === 0x7fe0 && element === 0x0010) return -1;
      // The file meta group (0002) is always Explicit VR LE regardless of the dataset syntax.
      const isExplicit = group === 0x0002 ? true : explicit;
      let vr = '';
      let len: number;
      let valueOff: number;
      if (isExplicit) {
        vr = String.fromCharCode(bytes[off + 4], bytes[off + 5]);
        if (LONG_VRS.has(vr)) {
          len = view.getUint32(off + 8, true);
          valueOff = off + 12;
        } else {
          len = view.getUint16(off + 6, true);
          valueOff = off + 8;
        }
      } else {
        len = view.getUint32(off + 4, true);
        valueOff = off + 8;
      }
      if (len === UNDEFINED) {
        // Undefined-length sequence (or encapsulated data): walk its items until the delimiter.
        if (depth > 16) throw new Error('DICOM nesting too deep');
        const next = readItems(valueOff, end, explicit, depth + 1);
        if (next < 0) return -1;
        off = next;
        continue;
      }
      if (valueOff + len > end) throw new Error(`Truncated DICOM element (${tag})`);
      const key = TAGS[tag];
      // Only take top-level values — nested sequences can repeat tags like Modality.
      if (key && depth === 0 && out[key] === undefined) {
        (out as unknown as Record<string, string>)[key] = decodeText(bytes.subarray(valueOff, valueOff + len));
      }
      off = valueOff + len;
      // The meta group ends where its declared length says; switch syntax after it.
      if (group === 0x0002 && off < end && view.getUint16(off, true) !== 0x0002) return off;
    }
    return off;
  }

  function readItems(start: number, end: number, explicit: boolean, depth: number): number {
    let off = start;
    while (off + 8 <= end) {
      const group = view.getUint16(off, true);
      const element = view.getUint16(off + 2, true);
      const len = view.getUint32(off + 4, true);
      if (group !== 0xfffe) throw new Error('Malformed DICOM sequence');
      if (element === 0xe0dd) return off + 8; // sequence delimitation
      if (element === 0xe000) {
        if (len === UNDEFINED) {
          off = readElements(off + 8, end, explicit, false, depth);
          if (off < 0) return -1;
        } else {
          off += 8 + len; // defined-length item: skip — we never read nested values
        }
        continue;
      }
      off += 8 + (len === UNDEFINED ? 0 : len);
    }
    return off;
  }

  try {
    const afterMeta = readElements(132, bytes.length, true, true, 0);
    const ts = out.transferSyntaxUid;
    if (!ts) return { supported: false, reason: 'DICOM file meta has no TransferSyntaxUID (0002,0010).' };
    if (ts === '1.2.840.10008.1.2.2' || ts === '1.2.840.10008.1.2.1.99') {
      return { ...out, supported: false, reason: `Transfer syntax ${ts} (big endian / deflated) is not parsed — enter details manually.` };
    }
    const explicit = ts !== '1.2.840.10008.1.2';
    if (afterMeta > 0) readElements(afterMeta, bytes.length, explicit, true, 0);
  } catch (err) {
    return { ...out, supported: false, reason: `Could not read DICOM header: ${(err as Error).message}` };
  }
  return out;
}

/**
 * DICOM DA (YYYYMMDD) -> FHIR date, or undefined if malformed. StudyTime is
 * deliberately NOT combined in: DICOM TM carries no timezone and FHIR
 * dateTime with a time part requires one — guessing an offset would invent data.
 */
export function dicomDateToFhir(da?: string): string | undefined {
  if (!da || !/^\d{8}$/.test(da)) return undefined;
  return `${da.slice(0, 4)}-${da.slice(4, 6)}-${da.slice(6, 8)}`;
}
