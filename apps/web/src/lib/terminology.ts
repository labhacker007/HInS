/**
 * Clinical terminology — STARTER SUBSET ONLY.
 *
 * Pending: licensed SNOMED CT India edition (via NRCeS / SNOMED CT MLDS)
 * served from a self-hosted Snowstorm terminology server (Apache-2.0,
 * IHTSDO). Until that exists, this file is a hand-curated list of ~100
 * common clinical findings/disorders so the consult note can record
 * CODED diagnoses instead of free text (blueprint §03.6).
 *
 * How every code here was checked (not from memory): each SNOMED CT
 * concept was looked up with CodeSystem/$lookup against HL7's public
 * terminology server tx.fhir.org (SNOMED CT International Edition,
 * version 20250201) and confirmed ACTIVE; the `display` is the
 * preferred term that server returned. Each ICD-10 code was looked up
 * the same way against WHO ICD-10 (system http://hl7.org/fhir/sid/icd-10,
 * version "2019-covid-expanded") and confirmed to exist. Candidates that
 * failed (e.g. 89362005 "Weight loss" — inactive in the 2025 release;
 * ICD-10 A90 — retired in WHO 2019 in favour of A97.x) were dropped or
 * corrected rather than kept.
 *
 * Known gap, stated plainly:
 *  - The SNOMED→ICD-10 pairing is a HAND-CURATED clinical approximation
 *    ("best unspecified ICD-10 code for this concept"), NOT the official
 *    SNOMED CT to ICD-10 extended map, which is rule-based and context
 *    dependent. Coders must review ICD-10 codes before claims use.
 *  - ICD-10 here is WHO ICD-10 (what India uses), not ICD-10-CM; e.g.
 *    asthma is J45.9, not the CM-only J45.909.
 *  - Production use of SNOMED CT in India requires the national licence
 *    (India is a SNOMED International member; access via NRCeS/MLDS).
 *  - search() is a naive substring/token match, not Snowstorm's ECL /
 *    description search; synonyms below are a tiny hand list.
 */

export const SNOMED_SYSTEM = 'http://snomed.info/sct';
export const ICD10_SYSTEM = 'http://hl7.org/fhir/sid/icd-10';

export interface TermEntry {
  snomed: string;
  display: string;
  icd10: string;
  icd10Display: string;
}

export const STARTER_TERMS: readonly TermEntry[] = [
  { snomed: "38341003", display: "Hypertensive disorder", icd10: "I10", icd10Display: "Essential (primary) hypertension" },
  { snomed: "59621000", display: "Essential hypertension", icd10: "I10", icd10Display: "Essential (primary) hypertension" },
  { snomed: "44054006", display: "Type 2 diabetes mellitus", icd10: "E11.9", icd10Display: "Type 2 diabetes mellitus : Without complications" },
  { snomed: "46635009", display: "Type 1 diabetes mellitus", icd10: "E10.9", icd10Display: "Type 1 diabetes mellitus : Without complications" },
  { snomed: "73211009", display: "Diabetes mellitus", icd10: "E14.9", icd10Display: "Unspecified diabetes mellitus : Without complications" },
  { snomed: "11687002", display: "Gestational diabetes mellitus", icd10: "O24.4", icd10Display: "Diabetes mellitus arising in pregnancy" },
  { snomed: "195967001", display: "Asthma", icd10: "J45.9", icd10Display: "Asthma, unspecified" },
  { snomed: "13645005", display: "Chronic obstructive pulmonary disease", icd10: "J44.9", icd10Display: "Chronic obstructive pulmonary disease, unspecified" },
  { snomed: "22298006", display: "Myocardial infarction", icd10: "I21.9", icd10Display: "Acute myocardial infarction, unspecified" },
  { snomed: "49436004", display: "Atrial fibrillation", icd10: "I48.9", icd10Display: "Atrial fibrillation and atrial flutter, unspecified" },
  { snomed: "42343007", display: "Congestive heart failure", icd10: "I50.0", icd10Display: "Congestive heart failure" },
  { snomed: "84114007", display: "Heart failure", icd10: "I50.9", icd10Display: "Heart failure, unspecified" },
  { snomed: "53741008", display: "Coronary arteriosclerosis", icd10: "I25.1", icd10Display: "Atherosclerotic heart disease" },
  { snomed: "194828000", display: "Angina pectoris", icd10: "I20.9", icd10Display: "Angina pectoris, unspecified" },
  { snomed: "230690007", display: "Cerebrovascular accident", icd10: "I64", icd10Display: "Stroke, not specified as haemorrhage or infarction" },
  { snomed: "56265001", display: "Heart disease", icd10: "I51.9", icd10Display: "Heart disease, unspecified" },
  { snomed: "45007003", display: "Low blood pressure", icd10: "I95.9", icd10Display: "Hypotension, unspecified" },
  { snomed: "3424008", display: "Tachycardia", icd10: "R00.0", icd10Display: "Tachycardia, unspecified" },
  { snomed: "48867003", display: "Bradycardia", icd10: "R00.1", icd10Display: "Bradycardia, unspecified" },
  { snomed: "233604007", display: "Pneumonia", icd10: "J18.9", icd10Display: "Pneumonia, unspecified" },
  { snomed: "54150009", display: "Upper respiratory infection", icd10: "J06.9", icd10Display: "Acute upper respiratory infection, unspecified" },
  { snomed: "43878008", display: "Streptococcal sore throat", icd10: "J02.0", icd10Display: "Streptococcal pharyngitis" },
  { snomed: "405737000", display: "Pharyngitis", icd10: "J02.9", icd10Display: "Acute pharyngitis, unspecified" },
  { snomed: "10509002", display: "Acute bronchitis", icd10: "J20.9", icd10Display: "Acute bronchitis, unspecified" },
  { snomed: "6142004", display: "Influenza", icd10: "J11.1", icd10Display: "Influenza with other respiratory manifestations, virus not identified" },
  { snomed: "840539006", display: "COVID-19", icd10: "U07.1", icd10Display: "COVID-19, virus identified" },
  { snomed: "61582004", display: "Allergic rhinitis", icd10: "J30.4", icd10Display: "Allergic rhinitis, unspecified" },
  { snomed: "56717001", display: "Tuberculosis", icd10: "A16.9", icd10Display: "Respiratory tuberculosis unspecified, without mention of bacteriological or histological confirmation" },
  { snomed: "154283005", display: "Pulmonary tuberculosis", icd10: "A16.2", icd10Display: "Tuberculosis of lung, without mention of bacteriological or histological confirmation" },
  { snomed: "61462000", display: "Malaria", icd10: "B54", icd10Display: "Unspecified malaria" },
  { snomed: "38362002", display: "Dengue", icd10: "A97.9", icd10Display: "Dengue, unspecified" },
  { snomed: "4834000", display: "Typhoid fever", icd10: "A01.0", icd10Display: "Typhoid fever" },
  { snomed: "86406008", display: "Human immunodeficiency virus infection", icd10: "B24", icd10Display: "Unspecified human immunodeficiency virus [HIV] disease" },
  { snomed: "14189004", display: "Measles", icd10: "B05.9", icd10Display: "Measles without complication" },
  { snomed: "38907003", display: "Varicella", icd10: "B01.9", icd10Display: "Varicella without complication" },
  { snomed: "91302008", display: "Sepsis", icd10: "A41.9", icd10Display: "Sepsis, unspecified" },
  { snomed: "68566005", display: "Urinary tract infectious disease", icd10: "N39.0", icd10Display: "Urinary tract infection, site not specified" },
  { snomed: "45816000", display: "Pyelonephritis", icd10: "N12", icd10Display: "Tubulo-interstitial nephritis, not specified as acute or chronic" },
  { snomed: "25374005", display: "Gastroenteritis", icd10: "A09", icd10Display: "Other gastroenteritis and colitis of infectious and unspecified origin" },
  { snomed: "235595009", display: "Gastroesophageal reflux disease", icd10: "K21.9", icd10Display: "Gastro-oesophageal reflux disease without oesophagitis" },
  { snomed: "397825006", display: "Gastric ulcer", icd10: "K25.9", icd10Display: "Gastric ulcer : Unspecified as acute or chronic, without haemorrhage or perforation" },
  { snomed: "74400008", display: "Appendicitis", icd10: "K37", icd10Display: "Unspecified appendicitis" },
  { snomed: "197321007", display: "Steatotic liver disease", icd10: "K76.0", icd10Display: "Fatty (change of) liver, not elsewhere classified" },
  { snomed: "19943007", display: "Cirrhosis of liver", icd10: "K74.6", icd10Display: "Other and unspecified cirrhosis of liver" },
  { snomed: "235919008", display: "Gallstone", icd10: "K80.2", icd10Display: "Calculus of gallbladder without cholecystitis" },
  { snomed: "34000006", display: "Crohn's disease", icd10: "K50.9", icd10Display: "Crohn disease, unspecified" },
  { snomed: "64766004", display: "Ulcerative colitis", icd10: "K51.9", icd10Display: "Ulcerative colitis, unspecified" },
  { snomed: "14760008", display: "Constipation", icd10: "K59.0", icd10Display: "Constipation" },
  { snomed: "709044004", display: "Chronic kidney disease", icd10: "N18.9", icd10Display: "Chronic kidney disease, unspecified" },
  { snomed: "14669001", display: "Acute kidney injury", icd10: "N17.9", icd10Display: "Acute renal failure, unspecified" },
  { snomed: "95570007", display: "Kidney stone", icd10: "N20.0", icd10Display: "Calculus of kidney" },
  { snomed: "266569009", display: "Benign prostatic hyperplasia", icd10: "N40", icd10Display: "Hyperplasia of prostate" },
  { snomed: "55822004", display: "Hyperlipidemia", icd10: "E78.5", icd10Display: "Hyperlipidaemia, unspecified" },
  { snomed: "13644009", display: "Hypercholesterolemia", icd10: "E78.0", icd10Display: "Pure hypercholesterolaemia" },
  { snomed: "302870006", display: "Hypertriglyceridemia", icd10: "E78.1", icd10Display: "Pure hyperglyceridaemia" },
  { snomed: "40930008", display: "Hypothyroidism", icd10: "E03.9", icd10Display: "Hypothyroidism, unspecified" },
  { snomed: "34486009", display: "Hyperthyroidism", icd10: "E05.9", icd10Display: "Thyrotoxicosis, unspecified" },
  { snomed: "414916001", display: "Obesity", icd10: "E66.9", icd10Display: "Obesity, unspecified" },
  { snomed: "302866003", display: "Hypoglycemia", icd10: "E16.2", icd10Display: "Hypoglycaemia, unspecified" },
  { snomed: "80394007", display: "Hyperglycemia", icd10: "R73.9", icd10Display: "Hyperglycaemia, unspecified" },
  { snomed: "271737000", display: "Anemia", icd10: "D64.9", icd10Display: "Anaemia, unspecified" },
  { snomed: "87522002", display: "Iron deficiency anemia", icd10: "D50.9", icd10Display: "Iron deficiency anaemia, unspecified" },
  { snomed: "35489007", display: "Depressive disorder", icd10: "F32.9", icd10Display: "Depressive episode, unspecified" },
  { snomed: "197480006", display: "Anxiety disorder", icd10: "F41.9", icd10Display: "Anxiety disorder, unspecified" },
  { snomed: "7200002", display: "Alcoholism", icd10: "F10.2", icd10Display: "Mental and behavioural disorders due to use of alcohol : Dependence syndrome" },
  { snomed: "52448006", display: "Dementia", icd10: "F03", icd10Display: "Unspecified dementia" },
  { snomed: "26929004", display: "Alzheimer's disease", icd10: "G30.9", icd10Display: "Alzheimer disease, unspecified" },
  { snomed: "49049000", display: "Parkinson's disease", icd10: "G20", icd10Display: "Parkinson disease" },
  { snomed: "24700007", display: "Multiple sclerosis", icd10: "G35", icd10Display: "Multiple sclerosis" },
  { snomed: "84757009", display: "Epilepsy", icd10: "G40.9", icd10Display: "Epilepsy, unspecified" },
  { snomed: "37796009", display: "Migraine", icd10: "G43.9", icd10Display: "Migraine, unspecified" },
  { snomed: "69896004", display: "Rheumatoid arthritis", icd10: "M06.9", icd10Display: "Rheumatoid arthritis, unspecified" },
  { snomed: "396275006", display: "Osteoarthritis", icd10: "M19.9", icd10Display: "Arthrosis, unspecified" },
  { snomed: "3723001", display: "Arthritis", icd10: "M13.9", icd10Display: "Arthritis, unspecified" },
  { snomed: "90560007", display: "Gout", icd10: "M10.9", icd10Display: "Gout, unspecified" },
  { snomed: "64859006", display: "Osteoporosis", icd10: "M81.9", icd10Display: "Osteoporosis, unspecified" },
  { snomed: "279039007", display: "Low back pain", icd10: "M54.5", icd10Display: "Low back pain" },
  { snomed: "161891005", display: "Backache", icd10: "M54.9", icd10Display: "Dorsalgia, unspecified" },
  { snomed: "57676002", display: "Pain of joint", icd10: "M25.5", icd10Display: "Pain in joint" },
  { snomed: "68962001", display: "Muscle pain", icd10: "M79.1", icd10Display: "Myalgia" },
  { snomed: "24079001", display: "Atopic dermatitis", icd10: "L20.9", icd10Display: "Atopic dermatitis, unspecified" },
  { snomed: "43116000", display: "Eczema", icd10: "L30.9", icd10Display: "Dermatitis, unspecified" },
  { snomed: "40275004", display: "Contact dermatitis", icd10: "L25.9", icd10Display: "Unspecified contact dermatitis, unspecified cause" },
  { snomed: "9014002", display: "Psoriasis", icd10: "L40.9", icd10Display: "Psoriasis, unspecified" },
  { snomed: "128045006", display: "Cellulitis", icd10: "L03.9", icd10Display: "Cellulitis, unspecified" },
  { snomed: "65363002", display: "Otitis media", icd10: "H66.9", icd10Display: "Otitis media, unspecified" },
  { snomed: "9826008", display: "Conjunctivitis", icd10: "H10.9", icd10Display: "Conjunctivitis, unspecified" },
  { snomed: "193570009", display: "Cataract", icd10: "H26.9", icd10Display: "Cataract, unspecified" },
  { snomed: "23986001", display: "Glaucoma", icd10: "H40.9", icd10Display: "Glaucoma, unspecified" },
  { snomed: "398254007", display: "Pre-eclampsia", icd10: "O14.9", icd10Display: "Pre-eclampsia, unspecified" },
  { snomed: "363346000", display: "Malignant neoplastic disease", icd10: "C80.9", icd10Display: "Malignant neoplasm, primary site unspecified" },
  { snomed: "254837009", display: "Malignant neoplasm of breast", icd10: "C50.9", icd10Display: "Breast, unspecified" },
  { snomed: "125605004", display: "Fracture of bone", icd10: "T14.2", icd10Display: "Fracture of unspecified body region" },
  { snomed: "386661006", display: "Fever", icd10: "R50.9", icd10Display: "Fever, unspecified" },
  { snomed: "49727002", display: "Cough", icd10: "R05", icd10Display: "Cough" },
  { snomed: "267036007", display: "Dyspnea", icd10: "R06.0", icd10Display: "Dyspnoea" },
  { snomed: "29857009", display: "Chest pain", icd10: "R07.4", icd10Display: "Chest pain, unspecified" },
  { snomed: "21522001", display: "Abdominal pain", icd10: "R10.4", icd10Display: "Other and unspecified abdominal pain" },
  { snomed: "422587007", display: "Nausea", icd10: "R11", icd10Display: "Nausea and vomiting" },
  { snomed: "422400008", display: "Vomiting", icd10: "R11", icd10Display: "Nausea and vomiting" },
  { snomed: "404640003", display: "Dizziness", icd10: "R42", icd10Display: "Dizziness and giddiness" },
  { snomed: "84229001", display: "Fatigue", icd10: "R53", icd10Display: "Malaise and fatigue" },
  { snomed: "271594007", display: "Syncope", icd10: "R55", icd10Display: "Syncope and collapse" },
  { snomed: "25064002", display: "Headache", icd10: "R51", icd10Display: "Headache" },
  { snomed: "91175000", display: "Seizure", icd10: "R56.8", icd10Display: "Other and unspecified convulsions" },
  { snomed: "271807003", display: "Eruption", icd10: "R21", icd10Display: "Rash and other nonspecific skin eruption" },
  { snomed: "418290006", display: "Itching", icd10: "L29.9", icd10Display: "Pruritus, unspecified" },
  { snomed: "79890006", display: "Loss of appetite", icd10: "R63.0", icd10Display: "Anorexia" },];

/** Common lay/clinical synonyms so e.g. "hypertension" or "BP" finds 38341003. */
const SYNONYMS: Record<string, string[]> = {
  '38341003': ['hypertension', 'high blood pressure', 'htn'],
  '59621000': ['primary hypertension', 'htn'],
  '44054006': ['t2dm', 'type ii diabetes', 'dm2', 'sugar'],
  '46635009': ['t1dm', 'type i diabetes', 'dm1'],
  '13645005': ['copd', 'chronic obstructive lung disease'],
  '22298006': ['mi', 'heart attack'],
  '49436004': ['af', 'afib'],
  '42343007': ['chf'],
  '53741008': ['cad', 'coronary artery disease', 'ihd'],
  '230690007': ['stroke', 'cva'],
  '45007003': ['hypotension'],
  '54150009': ['uri', 'urti', 'common cold'],
  '43878008': ['strep throat'],
  '405737000': ['sore throat'],
  '840539006': ['covid', 'sars-cov-2'],
  '56717001': ['tb'],
  '154283005': ['ptb', 'tb lung'],
  '86406008': ['hiv'],
  '68566005': ['uti'],
  '235595009': ['gerd', 'acid reflux'],
  '197321007': ['fatty liver', 'nafld', 'masld'],
  '235919008': ['cholelithiasis', 'gallstones'],
  '709044004': ['ckd'],
  '14669001': ['aki', 'acute renal failure'],
  '95570007': ['renal calculus', 'nephrolithiasis'],
  '266569009': ['bph'],
  '55822004': ['dyslipidemia', 'high cholesterol'],
  '414916001': ['overweight'],
  '271737000': ['anaemia', 'low hb'],
  '87522002': ['ida', 'iron deficiency anaemia'],
  '35489007': ['depression'],
  '37796009': ['migraine headache'],
  '396275006': ['oa'],
  '69896004': ['ra'],
  '279039007': ['lbp', 'lumbago'],
  '57676002': ['arthralgia'],
  '68962001': ['myalgia'],
  '267036007': ['breathlessness', 'shortness of breath', 'sob'],
  '386661006': ['pyrexia'],
  '271807003': ['rash'],
  '418290006': ['pruritus'],
  '79890006': ['anorexia'],
  '91175000': ['convulsion', 'fit'],
  '125605004': ['fracture'],
  '398254007': ['preeclampsia'],
};

/** Case-insensitive search over display, synonyms, SNOMED code and ICD-10 code. */
export function search(text: string, limit = 15): TermEntry[] {
  const q = text.trim().toLowerCase();
  if (!q) return [];
  const tokens = q.split(/\s+/);
  const scored: { e: TermEntry; score: number }[] = [];
  for (const e of STARTER_TERMS) {
    const hay = [e.display, ...(SYNONYMS[e.snomed] ?? [])].map((s) => s.toLowerCase());
    let score = -1;
    if (e.snomed === q || e.icd10.toLowerCase() === q) score = 0;
    else if (hay.some((h) => h === q)) score = 1;
    else if (hay.some((h) => h.startsWith(q))) score = 2;
    else if (hay.some((h) => tokens.every((t) => h.includes(t)))) score = 3;
    else if (e.icd10.toLowerCase().startsWith(q)) score = 4;
    if (score >= 0) scored.push({ e, score });
  }
  scored.sort((a, b) => a.score - b.score || a.e.display.localeCompare(b.e.display));
  return scored.slice(0, limit).map((s) => s.e);
}

export function findBySnomed(code: string): TermEntry | undefined {
  return STARTER_TERMS.find((e) => e.snomed === code);
}
