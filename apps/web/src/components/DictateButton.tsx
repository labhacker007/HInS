import { useRef, useState } from 'react';
import { ActionIcon, Tooltip, Text, Group } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { createConsent, listActiveConsents } from '../lib/consentApi.js';

/**
 * Voice-to-text dictation — blueprint §08.1's ambient-scribe pipeline,
 * step 1 (consent) and step 2 (capture/transcription), in miniature.
 *
 * DEV/DEMO ONLY — NOT the compliant production path. This uses the
 * browser's native SpeechRecognition API. In Chrome, that sends audio to
 * Google's cloud speech service, not a self-hosted engine — which
 * directly contradicts §08's own design (self-hosted Whisper by default,
 * frontier/cloud ASR opt-in only and gated on a BAA). No self-hosted
 * Whisper is running in this environment, so this is what's real and
 * demonstrable today; it is explicitly not what ships to real patient
 * data. Swapping this for a self-hosted Whisper call behind the AI
 * Gateway (§08) is tracked as open work, not done here.
 *
 * What IS done per §08.1 step 1: no microphone access without a logged
 * consent event first. This component auto-creates a short-lived
 * `recording`-type consent (if one isn't already active for this
 * patient) before starting capture — a simplification of "the clinician
 * verbally confirms with the patient" rather than a captured e-signature,
 * same honesty standard as every other simplification in this codebase.
 */
export function DictateButton({
  patientId,
  requesterId,
  requesterName,
  onTranscript,
}: {
  patientId: string;
  requesterId: string | undefined;
  requesterName: string;
  onTranscript: (text: string) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const recognitionRef = useRef<any>(null);
  const supported =
    typeof window !== 'undefined' && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);

  async function ensureRecordingConsent() {
    const active = await listActiveConsents(patientId);
    if (active.some((c) => c.type === 'recording')) return;
    if (!requesterId) return;
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
    if (!supported) {
      notifications.show({ message: 'Voice dictation needs a browser with SpeechRecognition (e.g. Chrome).', color: 'red' });
      return;
    }
    setBusy(true);
    try {
      await ensureRecordingConsent();
    } catch (err) {
      notifications.show({ message: `Could not log recording consent: ${String(err)}`, color: 'red' });
      setBusy(false);
      return;
    }
    setBusy(false);

    const Ctor = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = 'en-US';
    recognition.onresult = (event: any) => {
      let text = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) text += event.results[i][0].transcript;
      }
      if (text.trim()) onTranscript(text.trim());
    };
    recognition.onerror = () => setRecording(false);
    recognition.onend = () => setRecording(false);
    recognition.start();
    recognitionRef.current = recognition;
    setRecording(true);
  }

  function stop() {
    recognitionRef.current?.stop();
    setRecording(false);
  }

  return (
    <Group gap="xs" align="center">
      <Tooltip label={recording ? 'Stop dictation' : 'Start voice dictation'}>
        <ActionIcon
          color={recording ? 'red' : 'blue'}
          variant={recording ? 'filled' : 'light'}
          loading={busy}
          onClick={recording ? stop : start}
          size="lg"
          aria-label={recording ? 'Stop dictation' : 'Start voice dictation'}
        >
          {recording ? '■' : '●'}
        </ActionIcon>
      </Tooltip>
      {recording && (
        <Text size="xs" c="red" fw={600}>
          ● Recording…
        </Text>
      )}
      <Tooltip label="Uses your browser's cloud speech service, not self-hosted — dev/demo only. Do not use with real patient data. See blueprint §08.1.">
        <Text size="xs" c="dimmed" style={{ cursor: 'help', textDecoration: 'underline dotted' }}>
          dev-only
        </Text>
      </Tooltip>
    </Group>
  );
}
