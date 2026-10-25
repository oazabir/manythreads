// Thin facade over the router's focused modules: every name this file's importers use
// (`index.ts`, `test/router.test.ts`) still resolves here, so no caller changes.
export {
  buildPrompt,
  buildTaskPrompt,
  type CardFacts,
  matchTrigger,
  MAX_DELEGATION_DEPTH,
  mayTagSlugs,
  mentionedHandles,
  projectNote,
  type ProjectNote,
  type MessageView,
  type RoutedTrigger,
} from './match.ts';
export { holdForApproval, holdForGate, postNotice, previewText } from './holds.ts';
export {
  buildScope,
  checkGate,
  checkPreflight,
  loadDefinition,
  postReply,
  registerRunJob,
  RUN_QUEUE,
  type LlmDoor,
  type LoadedDefinition,
  type RepoDoor,
  type RunBotRow,
  RunPayload,
} from './run-job.ts';
export { registerApprovalResume, registerRouter } from './router-subscribe.ts';
