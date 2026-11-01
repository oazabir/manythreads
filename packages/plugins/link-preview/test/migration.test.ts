import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LINK_PREVIEW_IMAGE_TYPES } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { IMAGE_LIMITS } from '../src/fetch-preview.ts';
import { sniffImage } from '../src/parse.ts';

// DB-free guards on the migration text: the picture kinds the table accepts are exactly the kinds the shared schema names and the sniffer can return.

const sql = readFileSync(fileURLToPath(new URL('../migrations/0001_link_previews.sql', import.meta.url)), 'utf8');

describe('0001_link_previews.sql', () => {
  it('lists the same picture kinds as the shared schema, in the same order', () => {
    const check = /content_type text NOT NULL CHECK \(content_type IN \(([^)]*)\)\)/.exec(sql);
    expect(check).not.toBeNull();
    const kinds = [...(check?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(kinds).toEqual([...LINK_PREVIEW_IMAGE_TYPES]);
  });

  it('names no kind the sniffer can never return, and no SVG or HTML', () => {
    expect(LINK_PREVIEW_IMAGE_TYPES.join(' ')).not.toMatch(/svg|html|xml|ico/);
    const sniffed = new Set<string>([
      sniffImage(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)])),
      sniffImage(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(12)])),
      sniffImage(Buffer.from('GIF89a' + '\0'.repeat(8), 'latin1')),
      sniffImage(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(4)])),
      sniffImage(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypavif'), Buffer.alloc(4)])),
    ] as string[]);
    expect([...sniffed].sort()).toEqual([...LINK_PREVIEW_IMAGE_TYPES].sort());
  });

  it('turns row-level security on and forces it for every table it creates', () => {
    const tables = [...sql.matchAll(/CREATE TABLE app\.(\w+)/g)].map((m) => m[1]);
    expect(tables).toHaveLength(4);
    for (const t of tables) {
      expect(sql, t).toContain(`ALTER TABLE app.${t} ENABLE ROW LEVEL SECURITY`);
      expect(sql, t).toContain(`ALTER TABLE app.${t} FORCE ROW LEVEL SECURITY`);
      expect(sql, t).toMatch(new RegExp(`COMMENT ON TABLE app\\.${t} IS 'rls: `));
    }
  });

  it('never grants the cache table to the app role', () => {
    expect(sql).not.toMatch(/GRANT[^;]*link_preview_cache[^;]*manythreads_app/);
  });
});

const hardening = readFileSync(fileURLToPath(new URL('../migrations/0002_hardening.sql', import.meta.url)), 'utf8');

describe('0002_hardening.sql', () => {
  it('lowers the picture cap to 512 KiB for new rows only, and the code stores no more than that', () => {
    const check = /CHECK \(octet_length\(bytes\) BETWEEN 12 AND (\d+)\) NOT VALID/.exec(hardening);
    expect(check).not.toBeNull();
    expect(Number(check?.[1])).toBe(512 * 1024);
    expect(Number(check?.[1])).toBe(IMAGE_LIMITS.maxBytes);
  });

  it('lets every member read the rules, and only owners and admins change them (the write policy of 0001 is untouched)', () => {
    expect(hardening).toMatch(/CREATE POLICY link_preview_settings_select ON app\.link_preview_settings FOR SELECT\s+USING \(\(SELECT app\.is_system\(\)\) OR workspace_id = \(SELECT app\.workspace_id\(\)\)\)/);
    expect(hardening).not.toMatch(/link_preview_settings_(insert|update|delete)/);
  });

  it('lets the author, a channel manager and a workspace owner or admin remove a card, and nobody else', () => {
    const policy = /CREATE POLICY link_previews_remove ON app\.link_previews FOR UPDATE([\s\S]*?)COMMENT ON TABLE app\.link_previews/.exec(hardening)?.[1] ?? '';
    expect(policy).toMatch(/m\.author_id = \(SELECT app\.actor\(\)\)/);
    expect(policy).toMatch(/app\.channel_can\(channel_id, 'manage'\)/);
    expect(policy).toMatch(/app\.workspace_role\(\)\) IN \('owner', 'admin'\)/);
    expect(policy).toMatch(/channel_id = ANY \(\(SELECT app\.visible_channel_ids\('read'\)\)::uuid\[\]\)/);
    expect(policy).toMatch(/removed_by = \(SELECT app\.actor\(\)\)/);
  });

  it('replaces the old policy by name, so exactly one update policy is left', () => {
    expect(hardening).toMatch(/DROP POLICY link_previews_author_remove ON app\.link_previews/);
    expect(sql).toMatch(/CREATE POLICY link_previews_author_remove/);
  });

  it('keeps the table comments in the rls: format', () => {
    expect(hardening).toMatch(/COMMENT ON TABLE app\.link_preview_settings IS 'rls: /);
    expect(hardening).toMatch(/COMMENT ON TABLE app\.link_previews IS 'rls: /);
  });
});
