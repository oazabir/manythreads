import type { z } from 'zod';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** A route descriptor: what each `api/<area>/<op>.ts` exports as `<op>Route`. `:name` segments are path params. */
export type ApiRoute = { readonly method: HttpMethod; readonly path: string };

/** The schemas a client call parses with: `request` before sending, `response` after receiving. */
export type ApiSchemas<Req, Res> = {
  readonly request?: z.ZodType<Req>;
  readonly response: z.ZodType<Res>;
};
