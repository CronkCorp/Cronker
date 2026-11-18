import { readdir, readFile } from "node:fs/promises";
import pg from "pg";
import { repoPath } from "./paths.js";

/** SQL migrations in the repository's `migrations/`, applied in file-name order, each once. */
const migrationsDir = repoPath("migrations/");

async function migrationFiles(): Promise<{ name: string; sql: string }[]> {
  const names = (await readdir(migrationsDir)).filter((n) => n.endsWith(".sql")).sort();
  return Promise.all(names.map(async (name) => ({ name, sql: await readFile(migrationsDir + name, "utf8") })));
}

/** A string that changes whenever any migration changes. */
export async function migrationsFingerprint(): Promise<string> {
  return (await migrationFiles()).map((m) => `${m.name}\n${m.sql}`).join("\n");
}

export async function migrate(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock(hashtext('cronk_migrate'))");
    await client.query(
      "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
    );
    const applied = new Set(
      (await client.query<{ name: string }>("select name from schema_migrations")).rows.map((r) => r.name),
    );
    for (const migration of await migrationFiles()) {
      if (applied.has(migration.name)) continue;
      await client.query("begin");
      try {
        await client.query(migration.sql);
        await client.query("insert into schema_migrations (name) values ($1)", [migration.name]);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }
  } finally {
    await client.query("select pg_advisory_unlock(hashtext('cronk_migrate'))").catch(() => {});
    client.release();
  }
}

/** Whether a query failed on the named unique index or constraint. */
export function violates(error: unknown, constraint: string): boolean {
  const { code, constraint: violated } = error as { code?: string; constraint?: string };
  return code === "23505" && violated === constraint;
}

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

type OnCommit = () => void | Promise<void>;
const committed = new WeakMap<Tx, OnCommit[]>();

export async function transaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  const onCommit: OnCommit[] = [];
  committed.set(client, onCommit);
  let result: T;
  try {
    await client.query("begin");
    result = await fn(client);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    committed.delete(client);
    client.release();
  }
  for (const callback of onCommit) await callback();
  return result;
}

/**
 * Runs `callback` once the transaction commits, and never if it rolls back. The transaction
 * resolves once every such callback has, in the order they were added.
 */
export function afterCommit(tx: Tx, callback: OnCommit): void {
  const onCommit = committed.get(tx);
  if (!onCommit) throw new Error("afterCommit called outside a transaction");
  onCommit.push(callback);
}
