import { ForbiddenPluginSqlError, assertSafePluginSql } from '@manythreads/sdk';
import { describe, expect, it } from 'vitest';

// The statement filter for plugin transactions (a stopgap, docs/plugins/security.md). A transaction the server opened READ ONLY must not be ended or restarted by a plugin's SQL.

describe('assertSafePluginSql', () => {
  it('refuses statements that end or restart the server-opened transaction', () => {
    for (const sql of ['COMMIT', 'commit;', 'END', 'ABORT', 'BEGIN', 'begin read write', 'START TRANSACTION READ WRITE', 'PREPARE TRANSACTION \'x\'', 'ROLLBACK', 'rollback work', 'SELECT 1; COMMIT', '/* c */ commit']) {
      expect(() => assertSafePluginSql(sql), sql).toThrow(ForbiddenPluginSqlError);
    }
  });

  it('keeps savepoints and ordinary statements working', () => {
    for (const sql of [
      'SAVEPOINT s1',
      'RELEASE SAVEPOINT s1',
      'ROLLBACK TO SAVEPOINT s1',
      'rollback to s1',
      "SELECT CASE WHEN a THEN 1 ELSE 2 END FROM t WHERE note = 'commit'",
      'INSERT INTO t (begin_at, end_at) VALUES (now(), now())',
      'SELECT 1 -- COMMIT',
    ]) {
      expect(() => assertSafePluginSql(sql), sql).not.toThrow();
    }
  });

  it('still refuses what it refused before', () => {
    for (const sql of ["SELECT set_config('app.actor_id', 'x', true)", 'SET ROLE postgres', 'RESET ALL', 'DO $$ BEGIN END $$', 'ALTER ROLE x SUPERUSER']) {
      expect(() => assertSafePluginSql(sql), sql).toThrow(ForbiddenPluginSqlError);
    }
  });
});
