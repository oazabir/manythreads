import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { baseImages, builtImages, chartImages, installImages, listedImages, unpinnedImages } from '../src/images.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const page = readFileSync(join(root, 'docs/deploy/air-gapped.md'), 'utf8');

describe('docs/deploy/air-gapped.md lists every image the install builds or pulls', () => {
  const listed = listedImages(page);

  it('has every image the repository names, with the tag the repository pins', () => {
    const missing = installImages().filter((image) => !listed.includes(image.ref));
    expect(missing.map((m) => `${m.ref}  (from ${m.source})`)).toEqual([]);
  });

  it('lists nothing the repository no longer names', () => {
    const named = new Set(installImages().map((i) => i.ref));
    expect(listed.filter((ref) => !named.has(ref))).toEqual([]);
  });

  it('lists each image once', () => {
    expect(new Set(listed).size).toBe(listed.length);
  });

  it('finds the images it should (so an empty extraction cannot pass the test above)', () => {
    const refs = installImages().map((i) => i.ref);
    expect(refs).toEqual(expect.arrayContaining(['manythreads/server', 'manythreads/web', 'manythreads/workbench', 'manythreads/claude-pod', expect.stringMatching(/^node:22-slim@sha256:/), expect.stringMatching(/^registry:2\.8\.3@sha256:/)]));
    expect(refs.length).toBeGreaterThan(15);
  });
});

describe('every image of others is named by its digest (P27-01)', () => {
  it('no base image of a published image and no chart image is a bare tag', () => {
    expect(unpinnedImages(installImages()).map((i) => `${i.ref}  (from ${i.source})`)).toEqual([]);
  });

  it('knows an unpinned line when it sees one', () => {
    const d = 'a'.repeat(64);
    expect(unpinnedImages([{ ref: 'x:1', from: 'chart', source: 's' }, { ref: `x:1@sha256:${d}`, from: 'chart', source: 's' }, { ref: 'manythreads/server', from: 'built', source: 's' }]).map((i) => i.ref)).toEqual(['x:1']);
  });
});

describe('reading the sources', () => {
  it('builtImages expands the pod image name and skips the registry push', () => {
    const script = ['CP_NAME=claude-pod-fake', 'CP_NAME=claude-pod', 'docker build -f a -t "manythreads/$CP_NAME:$CP_TAG" "$CP_STAGE"', 'docker build -f b -t "127.0.0.1:30500/$PG_REF" deploy/postgres', 'docker build -t manythreads/hermes:stable .'].join('\n');
    expect(builtImages(script)).toEqual(['manythreads/claude-pod', 'manythreads/claude-pod-fake', 'manythreads/hermes']);
  });

  it('baseImages follows ARG defaults, skips stages and our own images', () => {
    const file = ['ARG BASE=ghcr.io/x/y:1@sha256:abc', 'FROM ${BASE} AS build', 'FROM node:22 AS models', 'FROM models', 'FROM manythreads/server:${TAG}', 'FROM ${BASE}'].join('\n');
    expect(baseImages(file)).toEqual(['ghcr.io/x/y:1@sha256:abc', 'node:22']);
  });

  it('chartImages keeps the images of others only', () => {
    expect(chartImages(['  image: manythreads/server', '  image: registry.local:5000/p/q:1', '  image: registry:2.8.3  # a comment', '    image: ""'].join('\n'))).toEqual(['registry:2.8.3']);
  });

  it('listedImages refuses a page with no block', () => {
    expect(() => listedImages('# nothing')).toThrow(/no block/);
  });
});
