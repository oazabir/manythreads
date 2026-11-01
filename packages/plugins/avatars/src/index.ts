import { definePlugin } from '@manythreads/sdk';
import { registerAvatarRoutes } from './routes.ts';

/**
 * Avatars: the profile picture of a person (PLAN P14-23). A person picks one of the built-in pictures, uploads a photo or leaves it empty (the web app then
 * draws their initials). The choice is `people.avatar` and the photo bytes are `person_photos` (kernel migration 0015); the roster and the session carry the
 * choice to the screens. A bot's picture is chosen through the bots plugin. docs/plugins/avatars.md lists the routes and the rules for a photo.
 */
export default definePlugin({
  manifest: {
    name: 'avatars',
    version: '0.1.0',
    kind: 'server',
    extends: [],
    events: { emits: [], consumes: [] },
  },
  register(ctx) {
    registerAvatarRoutes(ctx);
  },
});
