import type { PluginContext } from '@manythreads/sdk';
import {
  GetTemplateResponse,
  ListTemplatesResponse,
  getTemplateRoute,
  listTemplatesRoute,
} from '@manythreads/shared';
import { z } from 'zod';
import { json, notFound, route } from './http.ts';
import { toTemplateSummary } from './rows.ts';
import type { Deps } from './teams.ts';

const IdParams = z.object({ id: z.string().min(1).max(40) });

export function registerTemplateRoutes(ctx: PluginContext, { templates }: Deps): void {
  ctx.http.route({
    ...listTemplatesRoute,
    schema: { response: ListTemplatesResponse },
    handler: route(async () => json(ListTemplatesResponse.parse({ templates: (await templates.list()).map(toTemplateSummary) }))),
  });

  ctx.http.route({
    ...getTemplateRoute,
    schema: { response: GetTemplateResponse },
    handler: route(async (req) => {
      const { id } = IdParams.parse(req.params);
      const template = await templates.get(id);
      if (!template) throw notFound(`No team template "${id}"`);
      return json(GetTemplateResponse.parse({ template }));
    }),
  });
}
