import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { migrate, migrationsFingerprint } from "../../server/db.js";

/**
 * Disposable Postgres databases for tests.
 *
 * Each test gets its own database, copied from a migrated template so no test
 * pays for migrations. The template's name carries a fingerprint of the
 * migrations, so changing a migration builds a fresh template.
 */

const adminUrl =
  process.env.CRONK_TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";

function urlFor(database: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

async function withAdmin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function databaseExists(client: pg.Client, name: string): Promise<boolean> {
  const { rowCount } = await client.query("select 1 from pg_database where datname = $1", [name]);
  return rowCount === 1;
}

let templatePromise: Promise<string> | undefined;

function ensureTemplate(): Promise<string> {
  templatePromise ??= (async () => {
    const fingerprint = createHash("sha256").update(await migrationsFingerprint()).digest("hex");
    const name = `cronk_template_${fingerprint.slice(0, 16)}`;
    await withAdmin(async (client) => {
      // Serialise template creation across test workers.
      await client.query("select pg_advisory_lock(hashtext('cronk_test_template'))");
      try {
        if (await databaseExists(client, name)) return;
        const building = `${name}_building_${randomBytes(4).toString("hex")}`;
        await client.query(`create database "${building}"`);
        const pool = new pg.Pool({ connectionString: urlFor(building) });
        try {
          await migrate(pool);
        } finally {
          await pool.end();
        }
        await client.query(`alter database "${building}" rename to "${name}"`);
      } finally {
        await client.query("select pg_advisory_unlock(hashtext('cronk_test_template'))");
      }
    });
    return name;
  })();
  return templatePromise;
}

export interface TestDatabase {
  url: string;
  drop(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const template = await ensureTemplate();
  const name = `cronk_test_${randomBytes(6).toString("hex")}`;
  await withAdmin((client) => client.query(`create database "${name}" template "${template}"`));
  return {
    url: urlFor(name),
    drop: () => withAdmin((client) => client.query(`drop database if exists "${name}" with (force)`)).then(() => {}),
  };
}
