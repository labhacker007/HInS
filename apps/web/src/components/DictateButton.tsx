import { useEffect, useRef, useState } from 'react';
import { ActionIcon, Tooltip, Text, Group, Loader } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMedplumProfile } from '@medplum/react';
import { createConsent, listActiveConsents } from '../lib/consentApi.js';
import { formatHumanName } from '../lib/fhirFormat.js';
import { AsrUnavailableError, extensionFor, startRecording, transcribe, type AsrResult, type Recording } from '../lib/asr.js';

/**
 * Voice-to-text dictation — blueprint §08.1's ambient-scribe pipeline,
 * step 1 (consent) and step 2 (capture/transcription), in miniature.
 *
 * Capture: MediaRecorder in the browser (webm/opus). Transcription: our own
 * self-hosted Whisper (speaches, infra/docker-compose.asr.yml) via
 * lib/asr.ts — audio never leaves infrastructure we run. Press to record,
 * press again to stop; the transcript is APPENDED to the field via
 * onTranscript and stays fully editable. Nothing is saved until the
 * clinician saves the form.
 *
 * Accuracy honesty: the model is stock English-only Whisper. Its word error
 * rate on real clinical audio (accents, drug names, numbers) has NOT been
 * validated here, and Whisper can hallucinate text that was never said. We
 * enable VAD filtering and flag low-confidence segments, but every
 * transcript must be reviewed by the clinician.
 *
 * §08.1 step 1: when a patient is involved, no microphone access without a
 * logged consent event first. This component auto-creates a short-lived
 * `recording`-type consent (if one isn't already active for this patient)
 * before the mic turns on — a simplification of "the clinician verbally
 * confirms with the patient" rather than a captured e-signature. If no
 * consent exists and none can be logged (no signed-in requester), the mic is
 * NOT opened. The gate can only be skipped with `noPatientContext`, which the
 * type forbids combining with a patientId.
 */
type DictateButtonProps = {
  onTranscript: (text: string, result: AsrResult) => void;
  /** Smaller icon-only rendering for use inside an input's rightSection. */
  compact?: boolean;
  disabled?: boolean;
} & (
  | {
      patientId: string;
      /** Defaults to the signed-in profile. */
      requesterId?: string;
      requesterName?: string;
      noPatientContext?: never;
    }
  | {
      /** Explicitly declare that no patient is involved (e.g. admin forms);
       * skips the recording-consent gate. */
      noPatientContext: true;
      patientId?: never;
      requesterId?: never;
      requesterName?: never;
    }
);

type Phase = 'idle' | 'consent' | 'recording' | 'transcribing';

export function DictateButton(props: DictateButtonProps) {
  const { onTranscript, compact, disabled } = props;
  const profile = useMedplumProfile();
  const requesterId = props.requesterId ?? profile?.id;
  const requesterName = props.requesterName || (profile ? formatHumanName(profile.name as any) : '');
  const [phase, setPhase] = useState<Phase>('idle');
  const recordingRef = useRef<Recording | null>(null);

  // Release the microphone if the component unmounts mid-recording.
  useEffect(() => () => recordingRef.current?.cancel(), []);

  async function ensureRecordingConsent(patientId: string) {
    const active = await listActiveConsents(patientId);
    if (active.some((c) => c.type === 'recording')) return;
    if (!requesterId) throw new Error('no active recording consent and no signed-in clinician to log one');
    const start = new Date();
    const expiry = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    await createConsent({
      type: 'recording',
      grantorPatientId: patientId,
      scope: ['VoiceRecording'],
      purposeCode: 'treatment',
      requesterId,
      requesterDisplayName: requesterName,
      validityStart: start.toISOString(),
      validityExpiry: expiry.toISOString(),
    });
    notifications.show({ message: 'Recording consent logged for this encounter', color: 'blue' });
  }

  async function start() {
    if (!props.noPatientContext) {
      // Fail closed: a patient context with no id never skips the gate.
      if (!props.patientId) {
        notifications.show({ message: 'Select the patient before dictating — recording consent is per patient.', color: 'red' });
        return;
      }
      setPhase('consent');
      try {
        await ensureRecordingConsent(props.patientId);
      } catch (err) {
        notifications.show({ message: `Dictation blocked — could not confirm recording consent: ${String(err)}`, color: 'red' });
        setPhase('idle');
        return;
      }
    }
    try {
      recordingRef.current = await startRecording();
      setPhase('recording');
    } catch (err) {
      notifications.show({ message: `Microphone unavailable: ${err instanceof Error ? err.message : String(err)}`, color: 'red' });
      setPhase('idle');
    }
  }

  async function stop() {
    const rec = recordingRef.current;
    recordingRef.current = null;
    if (!rec) return setPhase('idle');
    setPhase('transcribing');
    try {
      const audio = await rec.stop();
      const result = await transcribe(audio, `dictation.${extensionFor(audio.type)}`);
      if (!result.text) {
        notifications.show({ message: 'No speech detected — nothing inserted.', color: 'yellow' });
        return;
      }
      onTranscript(result.text, result);
      const unsure = result.segments.filter((s) => s.lowConfidence);
      if (unsure.length) {
        notifications.show({
          color: 'orange',
          autoClose: 15000,
          title: 'Low-confidence dictation — check carefully',
          message: unsure.map((s) => `“${s.text}”`).join(' · '),
        });
      }
    } catch (err) {
      notifications.show({
        color: 'red',
        title: err instanceof AsrUnavailableError ? 'Speech-to-text server unreachable' : 'Dictation failed',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setPhase('idle');
    }
  }

  const recording = phase === 'recording';
  const busy = phase === 'consent' || phase === 'transcribing';
  const label = recording ? 'Stop dictation' : 'Start voice dictation';

  const button = (
    <Tooltip
      multiline
      w={280}
      label={
        recording
          ? 'Stop and transcribe'
          : 'Voice dictation — transcribed by our self-hosted Whisper (audio stays on our servers). Medical accuracy not validated; review every word before saving.'
      }
    >
      <ActionIcon
        color={recording ? 'red' : 'blue'}
        variant={recording ? 'filled' : 'subtle'}
        loading={busy}
        disabled={disabled}
        onClick={recording ? stop : start}
        size={compact ? 'sm' : 'md'}
        aria-label={label}
        data-dictate-state={phase}
      >
        <MicIcon size={compact ? 14 : 16} />
      </ActionIcon>
    </Tooltip>
  );

  if (compact) return button;

  return (
    <Group gap={6} align="center" wrap="nowrap">
      {button}
      {recording && (
        <Text size="xs" c="red" fw={600}>
          ● Recording… click to stop
        </Text>
      )}
      {phase === 'transcribing' && (
        <Group gap={4}>
          <Loader size={10} />
          <Text size="xs" c="dimmed">
            Transcribing…
          </Text>
        </Group>
      )}
    </Group>
  );
}

function MicIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10v1a7 7 0 0 0 14 0v-1" />
      <line x1="12" y1="18" x2="12" y2="22" />
    </svg>
  );
}
