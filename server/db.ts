import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";

/** SQL migrations, applied in file-name order, each once. */
const migrationsDir = fileURLToPath(new URL("../migrations/", import.meta.url));

// The build puts the server in dist/server, two levels down instead of one.
async function resolveMigrationsDir(): Promise<string> {
  for (const dir of [migrationsDir, fileURLToPath(new URL("../../migrations/", import.meta.url))]) {
    try {
      await readdir(dir);
      return dir;
    } catch {
      // try the next
    }
  }
  throw new Error("migrations directory not found");
}

async function migrationFiles(): Promise<{ name: string; sql: string }[]> {
  const dir = await resolveMigrationsDir();
  const names = (await readdir(dir)).filter((n) => n.endsWith(".sql")).sort();
  return Promise.all(names.map(async (name) => ({ name, sql: await readFile(dir + name, "utf8") })));
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

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export async function transaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
