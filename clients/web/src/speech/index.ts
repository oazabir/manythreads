export { getSpeechEngine, chooseSpeechEngine, registerWhisperBackend, resetSpeechEngine, noneEngine, NO_BACKEND_REASON, NO_PLATFORM_REASON } from './engine';
export { fakeAsrEnabled, createFakeEngine, fakeTranscript, FAKE_TEXT, FAKE_LANGUAGE } from './fake';
export { chooseModel, readDeviceFacts, hasSpeechPlatform, DEVICE_TABLE, TOO_WEAK_REASON } from './device';
export { decodeToSpeechAudio, clipDurationMs } from './decode';
export { resample, downmixToMono, toSpeechAudio, SPEECH_SAMPLE_RATE } from './resample';
export { SpeechError } from './types';
export type {
  PcmAudio,
  SpeechEngine,
  SpeechEngineKind,
  SpeechErrorCode,
  SpeechProgress,
  SpeechSegment,
  Transcript,
  TranscribeOptions,
  WhisperBackend,
  WhisperModelName,
} from './types';
export type { DeviceFacts, DeviceEnv, ModelChoice } from './device';
