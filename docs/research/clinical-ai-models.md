# Open models for clinical speech-to-text, OCR and NLP (research, 2026-10-20)

Decision-grade survey for HInS's AI layer (blueprint §08). English-to-English only for now.
Licences marked ✔ were verified against the model card or official page during this research;
unmarked items are from prior knowledge and must be re-checked before procurement.
**Nothing here is a cleared medical device — every output goes through clinician review before it
is written to FHIR.**

## 1. Speech-to-text

| Model | Licence | Notes |
|---|---|---|
| Whisper large-v3 / large-v3-turbo | MIT | Best general baseline on Indian English: on Svarah (9.6 h, 117 speakers) it beat commercial systems, but entity-heavy WER was still 11.2 ([arXiv 2305.15760](https://arxiv.org/abs/2305.15760)). Turbo ≈4–8× faster for a small accuracy cost. |
| distil-whisper (distil-large-v3/3.5) | MIT | English-only, fast; less tested on accented speech. |
| faster-whisper / [speaches](https://github.com/speaches-ai/speaches) | MIT (speaches licence not re-verified) | OpenAI-compatible `/v1/audio/transcriptions`. CPU or CUDA only — no Metal. |
| whisper.cpp | MIT | Metal on Apple Silicon; benchmark locally before relying on published speed figures. |
| NVIDIA Parakeet-TDT-0.6B-v3 | CC-BY-4.0 ✔ (commercial OK) | 6.34% avg on the Open ASR leaderboard; NVIDIA GPU/Linux ([card](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)). |
| NVIDIA Canary-Qwen-2.5B | CC-BY-4.0 ✔ (commercial OK) | 5.63% mean WER, English only ([card](https://huggingface.co/nvidia/canary-qwen-2.5b)). |
| Google MedASR (105M) | HAI-DEF terms ✔ (not OSI) | Google-reported 58% relative WER reduction vs Whisper large-v3 on its own eval — not independent. |

**Medical WER evidence is thin.** No independent head-to-head on clinical audio was found, and no
Indian-English medical ASR study. Usable references: PriMock57 ([2204.00333](https://arxiv.org/abs/2204.00333)),
MedWER protocol, AfriSpeech (Whisper ≈0.375 WER on accented clinical speech). **Build an internal
benchmark (~2 h of consented real dictation) and score candidates with MedWER before go-live.**

**Hallucination is documented:** Whisper invented whole phrases in ~1% of transcriptions, 38% of them
harmful, mostly over silences ([2402.08021](https://arxiv.org/abs/2402.08021); also reported by AP in
hospital deployments). Mitigations: VAD (Silero) to strip silence, `condition_on_previous_text=False`,
keep compression-ratio/log-prob thresholds, flag low-confidence segments in the UI, keep audio linked to
the transcript, never auto-commit, optionally cross-check with a transducer model (Parakeet) and diff.

**Diarization (ambient scribe):** pyannote `speaker-diarization-community-1`, CC-BY-4.0 ✔ (gated
download once, then offline). Do not use pyannote's hosted `precision-2` — audio would leave our infra.

## 2. OCR (lab sheets, notes, handwritten prescriptions)

| Model | Licence | Notes |
|---|---|---|
| Tesseract, PaddleOCR, docTR | Apache-2.0 | Good on printed lab sheets, poor on handwriting. |
| TrOCR | MIT | Line-level only; trained on English handwriting (IAM). |
| Florence-2 | MIT | Small, CPU-friendly; weak on dense documents. |
| Qwen3-VL (2B–32B) | Apache-2.0 ✔ | Robust OCR; no handwriting claim on the card. |
| olmOCR-2-7B | Apache-2.0 ✔ | 82.3 on olmOCR-Bench, 48.3 on old scans; handwriting untested. |
| Qwen2.5-VL-3B | Qwen Research Licence, non-commercial ✔ | **Avoid** (7B is Apache-2.0). |
| Surya / Marker | Weights: modified OpenRAIL-M, free only under $5M revenue ✔; Marker code reportedly GPL-3.0 | **Avoid** for a hospital product. |

**Indian handwriting:** MIRAGE (1,133 Indian doctors' simulated prescriptions,
[2410.09729](https://arxiv.org/abs/2410.09729)) — off-the-shelf GPT-4o ≈7.6% F1; fine-tuned open VLMs ≈82%
on medicine name + dosage; pharmacists themselves ≈75%. **Handwritten-prescription OCR must be
human-in-the-loop with formulary matching — do not promise automation.**

## 3. Clinical NLP → FHIR

| Model | Licence | Production use? |
|---|---|---|
| medspaCy | MIT | Yes — deterministic negation/sectioning guardrail. |
| scispaCy | Apache-2.0 | UMLS linker needs a UMLS licence; India uses SNOMED CT via NRCeS. |
| MedGemma 4B/27B | HAI-DEF ✔ | Custom terms (pass-through restrictions, regulatory responsibility on us, outputs must not directly inform diagnosis/treatment) — legal review first. |
| Meditron-70B, OpenBioLLM-70B, BioMistral-7B | Llama 2 / Llama 3 / Apache-2.0 ✔ | Authors disclaim clinical use — **not for production**. |
| Qwen3 8B/32B, gpt-oss-20b/120b, Mistral Small 3.x | Apache-2.0 (re-verify) | Recommended for SOAP→FHIR structuring with JSON-schema-constrained decoding. |

Pipeline: LLM extracts structure (schema-constrained, e.g. vLLM) → medspaCy negation check → terminology
lookup (SNOMED CT, CDCI/RxNorm, LOINC) → **clinician confirms** → Medplum writes Condition /
MedicationRequest / Observation. Every value must trace to a source-text span.

## Recommended stack

**Now (Mac dev box; Docker on macOS has no Metal GPU):** speaches on CPU with distil-large-v3 or
small.en int8 in Docker (what HInS ships today), or whisper.cpp natively with Metal for better speed;
PaddleOCR for printed pages; Qwen3-VL-4B/8B via native Ollama/MLX for handwriting experiments;
Qwen3-8B + medspaCy for structuring.

**Production (Linux GPU, L4/L40S/A100):** speaches/faster-whisper large-v3 with a Parakeet or
Canary-Qwen cross-check; pyannote community-1 + VAD for ambient scribe; olmOCR-2 or Qwen3-VL-8B/32B on
vLLM (PaddleOCR fallback); Qwen3-32B or gpt-oss-120b on vLLM + medspaCy + terminology services.
Release gate: internal benchmark sets for Indian-English dictation, ambient audio and prescription scans.

## Do not use
Surya/Marker weights (revenue cap; GPL code) · Qwen2.5-VL-3B / 72B (non-commercial/restricted) ·
Meditron / OpenBioLLM / BioMistral in production (authors disclaim) · any hosted ASR/diarization API
(audio leaves our infra — DPDP/HIPAA residency) · original canary-1b (reportedly CC-BY-NC) ·
raw Whisper without VAD and review · any OCR/LLM output auto-written to FHIR without clinician sign-off.

## Not verified in this round
speaches LICENSE file; Marker's GPL licence and InternVL3 per-size licences; Qwen3-VL handwriting
accuracy; independent clinical WER comparison; Apple Silicon speed figures; HAI-DEF Prohibited Use
Policy text; scispaCy UMLS requirement.
