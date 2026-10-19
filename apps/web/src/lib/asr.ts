/**
 * Self-hosted speech-to-text client (blueprint §08.1, step 2).
 *
 * Talks to the speaches container in infra/docker-compose.asr.yml — an
 * OpenAI-compatible `POST /v1/audio/transcriptions` running stock
 * English-only Whisper (faster-whisper / CTranslate2) on our own host. Audio
 * is recorded in the browser with MediaRecorder and POSTed straight to that
 * server; it is never sent to a third-party cloud.
 *
 * Hallucination mitigations (Whisper invents whole phrases in ~1% of
 * transcriptions, mostly over silence — Koenecke et al. 2024, arXiv
 * 2402.08021):
 *  - `vad_filter=true` on every request: Silero VAD strips non-speech before
 *    decoding (verified: 6 s of silence → "" with VAD, "You" without).
 *  - `temperature=0`, no `prompt` (an initial prompt is a known
 *    hallucination source).
 *  - `response_format=verbose_json`: per-segment avg_logprob /
 *    no_speech_prob / compression_ratio come back so the UI can flag
 *    low-confidence segments to the clinician.
 *  Not controllable through speaches 0.8.3's API: `condition_on_previous_text`
 *  (faster-whisper default true; irrelevant for clips under ~30 s, which is
 *  one decoding window) and temperature fallback (speaches passes a single
 *  float, so the compression-ratio / log-prob thresholds are evaluated but
 *  never trigger a re-decode).
 *
 * The model's accuracy on clinical vocabulary is NOT validated. Output is a
 * draft that is inserted into an editable field and only saved when the
 * clinician saves the form.
 */

export const ASR_URL: string = import.meta.env.VITE_ASR_URL || 'http://localhost:8000';
export const ASR_MODEL: string = import.meta.env.VITE_ASR_MODEL || 'Systran/faster-whisper-small.en';

/** Segment flagged when the decoder was unsure. Thresholds mirror
 * faster-whisper's own defaults (log_prob_threshold -1.0,
 * no_speech_threshold 0.6, compression_ratio_threshold 2.4). */
const LOW_LOGPROB = -1.0;
const HIGH_NO_SPEECH = 0.6;
const HIGH_COMPRESSION = 2.4;

export interface AsrSegment {
  text: string;
  start: number;
  end: number;
  avgLogprob: number;
  noSpeechProb: number;
  compressionRatio: number;
  lowConfidence: boolean;
}

export interface AsrResult {
  text: string;
  segments: AsrSegment[];
  durationSec: number;
}

export class AsrUnavailableError extends Error {}

export async function transcribe(audio: Blob, filename = 'dictation.webm'): Promise<AsrResult> {
  const form = new FormData();
  form.append('file', audio, filename);
  form.append('model', ASR_MODEL);
  form.append('language', 'en');
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');
  form.append('vad_filter', 'true');

  let res: Response;
  try {
    res = await fetch(`${ASR_URL.replace(/\/$/, '')}/v1/audio/transcriptions`, { method: 'POST', body: form });
  } catch {
    throw new AsrUnavailableError(
      `Speech-to-text server unreachable at ${ASR_URL}. Start it with: docker compose -f infra/docker-compose.asr.yml up -d`,
    );
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as Record<string, unknown>);
    const detail = (body as { detail?: unknown }).detail;
    throw new Error(`Speech-to-text failed (${res.status})${detail ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  }
  const data = (await res.json()) as {
    text?: string;
    duration?: number;
    segments?: Array<{ text: string; start: number; end: number; avg_logprob: number; no_speech_prob: number; compression_ratio: number }>;
  };
  const segments: AsrSegment[] = (data.segments ?? []).map((s) => ({
    text: s.text.trim(),
    start: s.start,
    end: s.end,
    avgLogprob: s.avg_logprob,
    noSpeechProb: s.no_speech_prob,
    compressionRatio: s.compression_ratio,
    lowConfidence: s.avg_logprob < LOW_LOGPROB || s.no_speech_prob > HIGH_NO_SPEECH || s.compression_ratio > HIGH_COMPRESSION,
  }));
  return { text: (data.text ?? '').trim(), segments, durationSec: data.duration ?? 0 };
}

export interface Recording {
  /** Stop capture, release the mic, and resolve with the recorded audio. */
  stop(): Promise<Blob>;
  /** Stop capture and release the mic, discarding the audio. */
  cancel(): void;
}

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return undefined;
}

export function extensionFor(mime: string): string {
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('mp4')) return 'm4a';
  return 'webm';
}

/** Ask for the mic and start recording. Callers must have checked consent
 * BEFORE calling this — this is the point the browser mic turns on. */
export async function startRecording(): Promise<Recording> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    throw new Error('This browser cannot record audio (needs getUserMedia + MediaRecorder).');
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  const release = () => stream.getTracks().forEach((t) => t.stop());
  recorder.start();

  return {
    stop: () =>
      new Promise<Blob>((resolve, reject) => {
        recorder.onstop = () => {
          release();
          resolve(new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' }));
        };
        recorder.onerror = (e) => {
          release();
          reject(new Error(`Recording failed: ${String((e as unknown as { error?: unknown }).error ?? e)}`));
        };
        if (recorder.state === 'inactive') {
          release();
          resolve(new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' }));
        } else {
          recorder.stop();
        }
      }),
    cancel: () => {
      recorder.onstop = null;
      if (recorder.state !== 'inactive') recorder.stop();
      release();
    },
  };
}
