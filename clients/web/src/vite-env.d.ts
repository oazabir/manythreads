/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Build-time test switch ("1" turns the fake speech engine on). Production builds never set it. */
  readonly VITE_MANYTHREADS_FAKE_ASR?: string;
  /** Build-time canary of the persona suite (`hide-composer` draws no composer). Only tools/review/canary.sh sets it; production builds never do. */
  readonly VITE_MANYTHREADS_CANARY?: string;
}
