import { useRef } from 'react';
import { Textarea, TextInput, type TextareaProps, type TextInputProps } from '@mantine/core';
import { DictateButton } from './DictateButton.js';

/**
 * Free-text clinical inputs with self-hosted voice dictation (see
 * DictateButton.tsx for consent + accuracy caveats). The mic sits in the
 * input's right section; dictated text is appended to whatever is already
 * typed and remains editable — nothing is saved until the form is saved.
 *
 * Pass `patientId` whenever the text is about a patient: that enforces the
 * logged recording-consent gate before the mic opens. Only pass
 * `noPatientContext` where no patient is involved.
 */
type DictationTarget =
  /** undefined = patient not chosen yet: the mic stays disabled. */
  | { patientId: string | undefined; noPatientContext?: never }
  | { noPatientContext: true; patientId?: never };

type ValueProps = {
  value: string;
  onValueChange: (value: string) => void;
};

export function appendDictation(current: string, chunk: string): string {
  const t = chunk.trim();
  if (!t) return current;
  if (!current.trim()) return t;
  return /\s$/.test(current) ? current + t : `${current} ${t}`;
}

function DictateSlot({ target, value, onValueChange, disabled }: { target: DictationTarget } & ValueProps & { disabled?: boolean }) {
  // Transcription is async: read the latest value at insert time so text
  // typed while Whisper was running is not overwritten.
  const latest = useRef(value);
  latest.current = value;
  const onTranscript = (t: string) => onValueChange(appendDictation(latest.current, t));
  if (target.noPatientContext) return <DictateButton compact noPatientContext onTranscript={onTranscript} disabled={disabled} />;
  return <DictateButton compact patientId={target.patientId ?? ''} onTranscript={onTranscript} disabled={disabled || !target.patientId} />;
}

export type DictationTextareaProps = Omit<TextareaProps, 'value' | 'onChange' | 'rightSection'> & ValueProps & DictationTarget;

export function DictationTextarea({ value, onValueChange, patientId, noPatientContext, ...rest }: DictationTextareaProps) {
  const target = (noPatientContext ? { noPatientContext: true } : { patientId }) as DictationTarget;
  return (
    <Textarea
      {...rest}
      value={value}
      onChange={(e) => onValueChange(e.currentTarget.value)}
      rightSection={<DictateSlot target={target} value={value} onValueChange={onValueChange} disabled={rest.disabled} />}
      rightSectionPointerEvents="all"
      rightSectionProps={{ style: { alignItems: 'flex-start', paddingTop: 6 } }}
    />
  );
}

export type DictationTextInputProps = Omit<TextInputProps, 'value' | 'onChange' | 'rightSection'> & ValueProps & DictationTarget;

export function DictationTextInput({ value, onValueChange, patientId, noPatientContext, ...rest }: DictationTextInputProps) {
  const target = (noPatientContext ? { noPatientContext: true } : { patientId }) as DictationTarget;
  return (
    <TextInput
      {...rest}
      value={value}
      onChange={(e) => onValueChange(e.currentTarget.value)}
      rightSection={<DictateSlot target={target} value={value} onValueChange={onValueChange} disabled={rest.disabled} />}
      rightSectionPointerEvents="all"
    />
  );
}
