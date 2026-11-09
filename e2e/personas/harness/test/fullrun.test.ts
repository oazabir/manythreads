import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clearPersonaPictures, fullRunOf } from '../fullrun.ts';
import { manifestFile, resultsFile } from '../manifest.ts';

const argv = (...args: string[]): string[] => ['/usr/bin/node', '/x/playwright/cli.js', 'test', ...args];

describe('fullRunOf', () => {
  it('a whole viewport project is a full run, and names the viewports', () => {
    expect(fullRunOf(argv('--project=personas-desktop')).kinds).toEqual(['desktop']);
    expect(fullRunOf(argv('--project', 'personas-desktop', '--project', 'personas-mobile-web', '--reporter=line')).kinds).toEqual(['desktop', 'mobile']);
    expect(fullRunOf(argv('--project=personas-mobile-web', '--workers', '1')).kinds).toEqual(['mobile']);
  });

  it('any narrowing is not a full run: grep, a file or title filter, last failed, a shard', () => {
    for (const extra of [['--grep', '@omar'], ['-g', 'O2'], ['--grep=@omar'], ['personas/desktop.spec.ts'], ['--last-failed'], ['--shard=1/2'], ['--grep-invert', '@lena']]) {
      expect(fullRunOf(argv('--project=personas-desktop', ...extra)).kinds, extra.join(' ')).toEqual([]);
    }
  });

  it('a run of other projects clears nothing', () => {
    expect(fullRunOf(argv('--project=api')).kinds).toEqual([]);
    expect(fullRunOf(argv('--project=personas-meta')).kinds).toEqual([]);
    expect(fullRunOf(['node', 'something-else.js']).kinds).toEqual([]);
  });
});

describe('clearPersonaPictures', () => {
  it("removes one persona's pictures, manifest and results for one viewport and leaves the rest", () => {
    const root = mkdtempSync(join(tmpdir(), 'mt-clear-'));
    try {
      for (const f of ['omar/01-O1-a.png', 'omar/02-O1-old.png', 'omar/mobile/01-O1-a.png', 'nadia/01-N1-a.png']) {
        mkdirSync(join(root, f, '..'), { recursive: true });
        writeFileSync(join(root, f), 'x');
      }
      for (const file of [manifestFile(root, 'omar', 'desktop'), resultsFile(root, 'omar', 'desktop'), manifestFile(root, 'omar', 'mobile')]) writeFileSync(file, '[]');
      expect(clearPersonaPictures(root, 'omar', 'desktop').sort()).toEqual(['01-O1-a.png', '02-O1-old.png']);
      expect(existsSync(join(root, 'omar', '02-O1-old.png'))).toBe(false);
      expect(existsSync(manifestFile(root, 'omar', 'desktop'))).toBe(false);
      expect(existsSync(resultsFile(root, 'omar', 'desktop'))).toBe(false);
      expect(existsSync(join(root, 'omar', 'mobile', '01-O1-a.png'))).toBe(true);
      expect(existsSync(manifestFile(root, 'omar', 'mobile'))).toBe(true);
      expect(existsSync(join(root, 'nadia', '01-N1-a.png'))).toBe(true);
      expect(clearPersonaPictures(root, 'omar', 'mobile')).toEqual(['mobile/01-O1-a.png']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
