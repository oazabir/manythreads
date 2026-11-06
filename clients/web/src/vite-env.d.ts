/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Build-time test switch ("1" turns the fake speech engine on). Production builds never set it. */
  readonly VITE_MANYTHREADS_FAKE_ASR?: string;
}
