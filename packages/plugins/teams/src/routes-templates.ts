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
    handler: route(() => Promise.resolve(json(ListTemplatesResponse.parse({ templates: templates.map(toTemplateSummary) })))),
  });

  ctx.http.route({
    ...getTemplateRoute,
    schema: { response: GetTemplateResponse },
    handler: route((req) => {
      const { id } = IdParams.parse(req.params);
      const template = templates.find((t) => t.id === id);
      if (!template) throw notFound(`No team template "${id}"`);
      return Promise.resolve(json(GetTemplateResponse.parse({ template })));
    }),
  });
}
