import type { FastifyBaseLogger } from "fastify";
import type { Clock } from "../clock.js";
import { transaction, type Db } from "../db.js";
import { ApiError } from "../http/errors.js";
import { hashPassword } from "./passwords.js";
import { hashSecret, issueSecret, secretMatches } from "./secrets.js";

/**
 * Setup turns a fresh installation into one with its first User and Workspace.
 * It is guarded by a one-time setup code that only the server log shows, so
 * nobody who merely reaches the address can claim the installation first.
 */

export async function isSetUp(db: Db): Promise<boolean> {
  const { rows } = await db.query<{ set_up_at: Date | null }>("select set_up_at from installation");
  return rows[0]?.set_up_at != null;
}

/**
 * On start, a fresh installation gets a new setup code, logged for whoever runs it.
 * Each start replaces the previous code, so only the latest log line's code works.
 */
export async function issueSetupCode(db: Db, log: FastifyBaseLogger): Promise<void> {
  const code = issueSecret("setup");
  const { rowCount } = await db.query(
    `insert into installation (id, setup_code_hash) values (true, $1)
     on conflict (id) do update set setup_code_hash = excluded.setup_code_hash
     where installation.set_up_at is null`,
    [hashSecret(code)],
  );
  if (rowCount === 0) return;
  log.info({ setupCode: code }, `Cronk is not set up yet. Open it and enter this setup code: ${code}`);
}

export interface SetupInput {
  setupCode: string;
  email: string;
  password: string;
  workspaceName: string;
}

export interface SetupResult {
  user: { id: string; email: string };
  workspace: { id: string; name: string };
}

export async function runSetup(db: Db, clock: Clock, input: SetupInput): Promise<SetupResult> {
  const passwordHash = await hashPassword(input.password);
  return transaction(db, async (tx) => {
    const { rows } = await tx.query<{ setup_code_hash: string | null; set_up_at: Date | null }>(
      "select setup_code_hash, set_up_at from installation for update",
    );
    const installation = rows[0];
    if (!installation || installation.set_up_at) {
      throw new ApiError(409, "already_set_up", "This installation is already set up.");
    }
    if (!installation.setup_code_hash || !secretMatches(input.setupCode, installation.setup_code_hash)) {
      throw new ApiError(403, "invalid_setup_code", "That setup code is not right. Use the latest one in Cronk's log.");
    }

    const now = clock.now();
    const email = input.email.trim();
    const user = await tx.query<{ id: string; email: string }>(
      "insert into users (email, password_hash, created_at) values ($1, $2, $3) returning id, email",
      [email, passwordHash, now],
    );
    const workspace = await tx.query<{ id: string; name: string }>(
      "insert into workspaces (name, created_at) values ($1, $2) returning id, name",
      [input.workspaceName.trim(), now],
    );
    await tx.query(
      "insert into memberships (workspace_id, user_id, is_admin, created_at) values ($1, $2, true, $3)",
      [workspace.rows[0]!.id, user.rows[0]!.id, now],
    );
    await tx.query("update installation set set_up_at = $1, setup_code_hash = null", [now]);
    return { user: user.rows[0]!, workspace: workspace.rows[0]! };
  });
}
