import {
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  personaActor,
  testKernelMigrationSource,
  type Persona,
  type TestDatabase,
} from '@majlis/test-utils';
import type pg from 'pg';
import { createAppPool, createSystemPool, withActor, withSystem, type Tx } from '../../src/index.ts';

/** A migrated database (kernel + test-kernel) with the seven personas, and the two pools tests use. */
export interface World {
  db: TestDatabase;
  appPool: pg.Pool;
  sysPool: pg.Pool;
  /** Run as `persona` on the majlis_app pool (RLS applies exactly as for that person's request). */
  as<T>(persona: Persona, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Run as the system actor on the majlis_system pool. */
  system<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function createWorld(): Promise<World> {
  const db = await createTestDatabase({ sources: [testKernelMigrationSource] });
  await createPersonas(db);
  const appPool = createAppPool(db.appUrl, 4);
  const sysPool = createSystemPool(db.systemUrl, 4);
  return {
    db,
    appPool,
    sysPool,
    as: (persona, fn) => withActor(personaActor(persona), fn, { pool: appPool }),
    system: (fn) => withSystem(fn, { pool: sysPool }),
    async close() {
      await appPool.end();
      await sysPool.end();
      await dropTestDatabase(db);
    },
  };
}

/** Rows of one query, as a list of one column. */
export async function column<T = string>(tx: Tx, sql: string, values: unknown[] = []): Promise<T[]> {
  const res = await tx.query(sql, values);
  const key = res.fields[0]?.name;
  return key ? res.rows.map((r) => r[key] as T) : [];
}
