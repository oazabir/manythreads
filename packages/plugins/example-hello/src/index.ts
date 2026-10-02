import { definePlugin, type PluginTx } from '@manythreads/sdk';

async function greet(tx: PluginTx, teamId: string, message: string): Promise<void> {
  await tx.query('INSERT INTO app.hello_greetings (team_id, message) VALUES ($1, $2)', [teamId, message]);
}

export default definePlugin({
  manifest: {
    name: 'example-hello',
    version: '0.1.0',
    kind: 'server',
    extends: ['event.subscribe'],
    capabilities: [{ name: 'hello.greet', destructive: false }],
    events: { emits: [], consumes: ['channel.message.posted'] },
    migrations: 'migrations',
  },
  register(ctx) {
    ctx.events.subscribe('channel.message.posted', async (event, tx) => {
      if (typeof event['teamId'] === 'string') await greet(tx, event['teamId'], 'hello from a message');
    });
    ctx.capabilities.register('hello.greet', async (input, tx) => {
      const { teamId, message } = input;
      if (typeof teamId !== 'string') throw new Error('hello.greet needs a teamId');
      await greet(tx, teamId, typeof message === 'string' ? message : 'hello');
      return { greeted: true };
    });
  },
});
