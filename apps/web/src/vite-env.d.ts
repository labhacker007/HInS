/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MEDPLUM_BASE_URL: string;
  readonly VITE_MEDPLUM_CLIENT_ID: string;
  readonly VITE_CONSENT_SERVICE_URL: string;
  readonly VITE_AUDIT_SERVICE_URL: string;
  /** Self-hosted speaches (Whisper) base URL — infra/docker-compose.asr.yml. */
  readonly VITE_ASR_URL?: string;
  /** CTranslate2 Whisper model id served by speaches. */
  readonly VITE_ASR_MODEL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
