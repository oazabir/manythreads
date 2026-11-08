import { boxModule } from './box.ts';
import { confluenceModule } from './confluence.ts';
import { dropboxModule } from './dropbox.ts';
import type { StandInModule } from './types.ts';
import { supportModule } from './support.ts';
import { telegramModule } from './telegram.ts';
import { trackersModule } from './trackers.ts';
import { workspaceModule } from './workspace.ts';

/*
 * The stand-ins fake-saas starts, in port order. APPEND ONLY: a work package adds its module as one new import line and one new line in the list below (Bundle D: D1
 * adds confluence, dropbox and box; B1 adds whatsapp; B2 adds slack and teams), so two packages never edit the same line. The first module takes the base port, the
 * control port is the base port + 1, and the rest follow in this order; a module that opens several servers declares `ports`.
 *
 * A module that needs a control action of its own answers `control(request)` and is reached at `/__fake/<id>/...`.
 */
export const PROVIDER_MODULES: readonly StandInModule[] = [
  workspaceModule, // Google, Microsoft 365, Notion
  trackersModule, // Jira, Linear, GitHub Issues, Asana
  supportModule, // Zendesk, Intercom, HubSpot, Salesforce
  telegramModule, // Telegram Bot API
  confluenceModule, // Confluence Cloud (document source)
  dropboxModule, // Dropbox (document source)
  boxModule, // Box (document source)
];
