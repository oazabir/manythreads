// The review tools need Playwright and axe-core, which the e2e package already installs. Loading them from there means this package adds no dependency (and no
// lockfile entry). Values come through `createRequire` anchored at e2e/package.json; the shapes this package uses are declared below, so no type from them leaks.
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const requireFromE2e = createRequire(join(REPO_ROOT, 'e2e', 'package.json'));

/** The part of a Playwright page the tools use. A real `Page` fits it. */
export interface PageLike {
  evaluate<R>(script: string): Promise<R>;
  setContent(html: string, options?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' }): Promise<void>;
  screenshot(options?: { fullPage?: boolean; type?: 'png' }): Promise<Buffer>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  close(): Promise<void>;
}

export interface ContextLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}

export interface BrowserLike {
  /** axe-core needs a page that belongs to a context: use this, not `newPage`, for pages it will check. */
  newContext(options?: { viewport?: { width: number; height: number } }): Promise<ContextLike>;
  newPage(options?: { viewport?: { width: number; height: number }; deviceScaleFactor?: number }): Promise<PageLike>;
  close(): Promise<void>;
}

export interface ChromiumLike {
  launch(options?: { headless?: boolean }): Promise<BrowserLike>;
}

export interface AxeResultLike {
  violations: Array<{ id: string; impact?: string | null; help: string; helpUrl?: string; nodes: Array<{ target: unknown[] }> }>;
}

export interface AxeBuilderLike {
  withTags(tags: string[]): AxeBuilderLike;
  analyze(): Promise<AxeResultLike>;
}

export type AxeBuilderConstructor = new (options: { page: unknown }) => AxeBuilderLike;

export function loadChromium(): ChromiumLike {
  return (requireFromE2e('@playwright/test') as { chromium: ChromiumLike }).chromium;
}

export function loadAxeBuilder(): AxeBuilderConstructor {
  const loaded = requireFromE2e('@axe-core/playwright') as { AxeBuilder?: AxeBuilderConstructor; default?: AxeBuilderConstructor };
  const ctor = loaded.AxeBuilder ?? loaded.default;
  if (!ctor) throw new Error('@axe-core/playwright did not export AxeBuilder');
  return ctor;
}
