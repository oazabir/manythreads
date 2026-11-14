export { createFakeAcpAgent, type FakeAcpAgent, type Received } from './agent.ts';
export { runTerminalAuth, type TerminalIo } from './login.ts';
export {
  DEFAULT_SCRIPT,
  loadScript,
  type Action,
  type AuthScript,
  type FakeScript,
  type Flavor,
  type HelperAction,
  type PermissionAction,
  type StepAction,
} from './script.ts';
