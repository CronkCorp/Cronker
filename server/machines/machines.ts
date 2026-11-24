import { randomInt } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { afterCommit, transaction, type Db } from "../db.js";
import { ApiError } from "../http/errors.js";
import { isUuid } from "../http/ids.js";
import { hashSecret, issueSecret } from "../identity/secrets.js";
import { revokeLocalRunToken } from "../runs/local.js";
import { noSuchRunner } from "../runs/runners.js";
import { startWaitingRuns, stopRunningRun } from "../runs/runs.js";

/**
 * Machines: a User's own computers running the `cronk-runner` daemon, each serving some of that User's `local`
 * Runners (ADR 0014). A Machine is paired by a device-code flow: the daemon asks for a code, its User approves the
 * short user code on the Runners page, picking the Runners it serves, and the daemon polls until it receives its
 * Machine token, once. Cronk keeps only the token's hash; unpairing revokes it.
 */

/**
 * The oldest `cronk-runner` daemon this Cronk works with. A daemon older than it is refused with `daemon_too_old`, at
 * pairing and on every call. Raise it when the daemon protocol changes in a way older daemons get wrong
 * (`docs/releasing.md`).
 */
export const minDaemonVersion = "0.3.0";

/** The header a daemon names its version in, on every call with its Machine token. */
export const daemonVersionHeader = "x-cronk-runner-version";
/** The header a daemon names its Machine's limit in, on every call with its Machine token. */
export const machineLimitHeader = "x-cronk-runner-limit";

/** A version's numbers, such as `[0, 3, 0]` for `0.3.0`, and whether it is a pre-release; null if it isn't one. */
function parseVersion(
  version: string,
): { numbers: number[]; pre: boolean } | null {
  const match =
    /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.exec(
      version.trim(),
    );
  if (!match) return null;
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] !== undefined,
  };
}

/** Whether a daemon of this version is too old for this Cronk: older than `minDaemonVersion`, or no version at all. */
export function isTooOld(version: string): boolean {
  const given = parseVersion(version);
  const least = parseVersion(minDaemonVersion)!;
  if (!given) return true;
  for (let i = 0; i < 3; i++) {
    if (given.numbers[i]! !== least.numbers[i]!)
      return given.numbers[i]! < least.numbers[i]!;
  }
  // `0.3.0-rc.1` comes before `0.3.0`.
  return given.pre && !least.pre;
}

const daemonTooOld = (version: string) =>
  new ApiError(
    426,
    "daemon_too_old",
    `This Cronk works with cronk-runner ${minDaemonVersion} or later, and this Machine runs ${version}: upgrade cronk-runner to ${minDaemonVersion} or later, then start it again.`,
  );

/** How long a pairing code works. */
export const pairingLifetimeMs = 10 * 60 * 1000;
/** How often the daemon should poll a pairing, in seconds. */
const pollInterval = 2;
/** The user code's letters: consonants only, so a code spells no word and reads aloud without confusion. */
const userCodeAlphabet = "BCDFGHJKLMNPQRSTVWXZ";

/** A user code as typed: its letters, uppercase, without the dash or spaces. */
const normaliseUserCode = (code: string): string =>
  code.toUpperCase().replace(/[^A-Z]/g, "");

function newUserCode(): string {
  let code = "";
  for (let i = 0; i < 8; i++)
    code += userCodeAlphabet[randomInt(userCodeAlphabet.length)];
  return code;
}

/** A user code as shown: two groups of four, such as `BCDF-GHJK`. */
const shownUserCode = (code: string): string =>
  `${code.slice(0, 4)}-${code.slice(4)}`;

const MachineName = Type.String({
  minLength: 1,
  maxLength: 100,
  pattern: "\\S",
  description: "The Machine's host name, as its daemon gives it.",
});
const MachineOs = Type.String({
  minLength: 1,
  maxLength: 50,
  description: "Its operating system, such as `darwin` or `linux`.",
});
const DaemonVersion = Type.String({
  minLength: 1,
  maxLength: 50,
  description: "The version of its `cronk-runner` daemon.",
});
const MachineLimit = Type.Integer({
  minimum: 1,
  maximum: 100,
  description: "The most Runs it runs at once across all its Runners.",
});

/** The ask-for-a-pairing-code route's body, sent by the daemon. */
export const PairingStart = Type.Object({
  name: MachineName,
  os: MachineOs,
  daemonVersion: DaemonVersion,
  limit: Type.Optional(MachineLimit),
});
export type PairingStart = Static<typeof PairingStart>;

export const StartedPairing = Type.Object({
  deviceCode: Type.String({
    description: "The secret the daemon polls with. Keep it to the daemon.",
  }),
  userCode: Type.String({
    description:
      "The short code the User types on the Runners page, such as `BCDF-GHJK`.",
  }),
  verificationUrl: Type.String({
    format: "uri",
    description: "The Runners page, where the User approves the code.",
  }),
  expiresAt: Type.String({
    format: "date-time",
    description: "When the code stops working, ten minutes after it was made.",
  }),
  interval: Type.Integer({
    description: "How many seconds the daemon waits between polls.",
  }),
});
export type StartedPairing = Static<typeof StartedPairing>;

/** Starts a pairing for a daemon: a device code for it to poll with, and a user code for its User to approve. */
export async function startPairing(
  context: Context,
  input: PairingStart,
): Promise<StartedPairing> {
  if (isTooOld(input.daemonVersion))
    throw daemonTooOld(input.daemonVersion.trim());
  const deviceCode = issueSecret("device_code");
  const now = context.clock.now();
  const expiresAt = new Date(now.getTime() + pairingLifetimeMs);
  // Pairings nobody can redeem any more are no use to anyone.
  await context.db.query(
    "delete from machine_pairings where expires_at <= $1",
    [now],
  );
  for (;;) {
    const userCode = newUserCode();
    const { rowCount } = await context.db.query(
      `insert into machine_pairings (device_code_hash, user_code, name, os, daemon_version, run_limit, created_at, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (user_code) do nothing`,
      [
        hashSecret(deviceCode),
        userCode,
        input.name.trim(),
        input.os.trim(),
        input.daemonVersion.trim(),
        input.limit ?? 2,
        now,
        expiresAt,
      ],
    );
    if (rowCount) {
      return {
        deviceCode,
        userCode: shownUserCode(userCode),
        verificationUrl: new URL("/runners", context.config.publicUrl).href,
        expiresAt: expiresAt.toISOString(),
        interval: pollInterval,
      };
    }
  }
}

/** The poll-a-pairing route's body. */
export const PairingPoll = Type.Object({
  deviceCode: Type.String({ minLength: 1, maxLength: 200 }),
});
export type PairingPoll = Static<typeof PairingPoll>;

export const PairedMachine = Type.Object({
  machineToken: Type.String({
    description:
      "The Machine's token, given this once: the daemon keeps it where only its User can read it.",
  }),
  machine: Type.Object({
    id: Type.String({ format: "uuid" }),
    name: Type.String(),
  }),
});
export type PairedMachine = Static<typeof PairedMachine>;

const pairingGone = () =>
  new ApiError(
    410,
    "pairing_expired",
    "That pairing code expired, was already used or never existed: run `cronk-runner login` again.",
  );

/**
 * Redeems an approved pairing for its Machine token, once; until its User approves it, refused with
 * `pairing_pending`. A pairing that expired or was redeemed already is refused with `pairing_expired`.
 */
export async function pollPairing(
  context: Context,
  deviceCode: string,
): Promise<PairedMachine> {
  return transaction(context.db, async (tx) => {
    const now = context.clock.now();
    const { rows } = await tx.query<{
      id: string;
      machineId: string | null;
      expired: boolean;
      redeemed: boolean;
    }>(
      `select id, machine_id as "machineId", expires_at <= $2 as expired, redeemed_at is not null as redeemed
       from machine_pairings where device_code_hash = $1 for update`,
      [hashSecret(deviceCode), now],
    );
    const pairing = rows[0];
    if (!pairing || pairing.expired || pairing.redeemed) throw pairingGone();
    if (!pairing.machineId) {
      throw new ApiError(
        409,
        "pairing_pending",
        "Its User hasn't approved the code yet: poll again shortly.",
      );
    }
    await tx.query(
      "update machine_pairings set redeemed_at = $2 where id = $1",
      [pairing.id, now],
    );
    const machineToken = issueSecret("machine");
    const { rows: machines } = await tx.query<{ id: string; name: string }>(
      "update machines set token_hash = $2, last_contact_at = $3 where id = $1 and revoked_at is null returning id, name",
      [pairing.machineId, hashSecret(machineToken), now],
    );
    // Unpaired between approval and the poll.
    if (!machines[0]) throw pairingGone();
    return { machineToken, machine: machines[0] };
  });
}

/** A paired Machine as its User sees it on the Runners page. */
export const Machine = Type.Object({
  id: Type.String({ format: "uuid" }),
  name: Type.String(),
  os: Type.String(),
  daemonVersion: Type.String(),
  limit: Type.Integer({
    minimum: 1,
    description: "The most Runs it runs at once across all its Runners.",
  }),
  pairedAt: Type.String({ format: "date-time" }),
  lastContactAt: Type.Union(
    [Type.String({ format: "date-time" }), Type.Null()],
    {
      description:
        "When its daemon last called Cronk; null before it received its token.",
    },
  ),
  runners: Type.Array(
    Type.Object({ id: Type.String({ format: "uuid" }), name: Type.String() }),
    {
      description: "The `local` Runners of its User's it serves, by name.",
    },
  ),
  connected: Type.Boolean({
    description:
      "Whether its daemon holds its event stream open now, so it hears of Runs to claim.",
  }),
  upgradeTo: Type.Union([Type.String(), Type.Null()], {
    description:
      "While its daemon's version is older than this Cronk works with, the version to upgrade `cronk-runner` to: its " +
      "calls are refused with `daemon_too_old` until then. Null while its version is fine.",
  }),
});
export type Machine = Static<typeof Machine>;

type MachineRow = Omit<Machine, "pairedAt" | "lastContactAt" | "upgradeTo"> & {
  pairedAt: Date;
  lastContactAt: Date | null;
};
const machineColumns = `machines.id, machines.name, machines.os, machines.daemon_version as "daemonVersion",
  machines.run_limit as limit, machines.paired_at as "pairedAt", machines.last_contact_at as "lastContactAt",
  machines.connections > 0 as connected,
  coalesce((select json_agg(json_build_object('id', runners.id, 'name', runners.name) order by lower(runners.name), runners.id)
    from machine_runners join runners on runners.id = machine_runners.runner_id
    where machine_runners.machine_id = machines.id), '[]') as runners`;
const presentMachine = (row: MachineRow): Machine => ({
  ...row,
  pairedAt: row.pairedAt.toISOString(),
  lastContactAt: row.lastContactAt?.toISOString() ?? null,
  upgradeTo: isTooOld(row.daemonVersion) ? minDaemonVersion : null,
});

/** The User's paired Machines, oldest first; unpaired ones are gone. */
export async function machinesOf(
  context: Context,
  userId: string,
): Promise<Machine[]> {
  const { rows } = await context.db.query<MachineRow>(
    `select ${machineColumns} from machines where owner_id = $1 and revoked_at is null order by paired_at, id`,
    [userId],
  );
  return rows.map(presentMachine);
}

/** The approve-a-pairing route's body. */
export const PairingApproval = Type.Object({
  userCode: Type.String({
    minLength: 1,
    maxLength: 20,
    description: "The code `cronk-runner login` shows, such as `BCDF-GHJK`.",
  }),
  runnerIds: Type.Array(Type.String(), {
    minItems: 1,
    maxItems: 100,
    uniqueItems: true,
    description: "Which of your own `local` Runners the Machine serves.",
  }),
});
export type PairingApproval = Static<typeof PairingApproval>;

/**
 * Approves a pairing by its user code, pairing its Machine with the User to serve the given Runners: each must be the
 * User's own (another's answers as not found) and of the kind `local` (`runner_not_local`). A code that expired, was
 * approved already or never existed is refused with `pairing_not_found`.
 */
export async function approvePairing(
  context: Context,
  userId: string,
  input: PairingApproval,
): Promise<Machine> {
  return transaction(context.db, async (tx) => {
    const now = context.clock.now();
    const ids = input.runnerIds;
    if (!ids.every(isUuid)) throw noSuchRunner();
    const { rows: runners } = await tx.query<{
      id: string;
      name: string;
      kind: string;
    }>(
      "select id, name, kind from runners where id = any($1::uuid[]) and owner_id = $2 for share",
      [ids, userId],
    );
    if (runners.length !== ids.length) throw noSuchRunner();
    const notLocal = runners.find((runner) => runner.kind !== "local");
    if (notLocal) {
      throw new ApiError(
        409,
        "runner_not_local",
        `${notLocal.name} is a Runner of the kind ${notLocal.kind}: a Machine serves only Runners of the kind local.`,
      );
    }
    const { rows } = await tx.query<{
      id: string;
      name: string;
      os: string;
      daemonVersion: string;
      limit: number;
    }>(
      `select id, name, os, daemon_version as "daemonVersion", run_limit as limit from machine_pairings
       where user_code = $1 and expires_at > $2 and machine_id is null for update`,
      [normaliseUserCode(input.userCode), now],
    );
    const pairing = rows[0];
    if (!pairing) {
      throw new ApiError(
        404,
        "pairing_not_found",
        "No Machine is waiting with that code: it expired, was already approved, or was mistyped. Run `cronk-runner login` again for a new one.",
      );
    }
    const { rows: machines } = await tx.query<{ id: string }>(
      `insert into machines (owner_id, name, os, daemon_version, run_limit, paired_at)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [
        userId,
        pairing.name,
        pairing.os,
        pairing.daemonVersion,
        pairing.limit,
        now,
      ],
    );
    const machineId = machines[0]!.id;
    await tx.query(
      "insert into machine_runners (machine_id, runner_id) select $1, unnest($2::uuid[])",
      [machineId, ids],
    );
    await tx.query(
      "update machine_pairings set machine_id = $2, approved_at = $3 where id = $1",
      [pairing.id, machineId, now],
    );
    const { rows: approved } = await tx.query<MachineRow>(
      `select ${machineColumns} from machines where id = $1`,
      [machineId],
    );
    return presentMachine(approved[0]!);
  });
}

/**
 * Unpairs one of the User's Machines: its token is revoked, so its daemon's later calls are refused, and the Runs it
 * holds stop, freeing their Runners' slots, as when a User takes their Tickets away. Its daemon can't confirm the stops,
 * so none is told again; it kills its Runs itself once Cronk refuses its token.
 */
export async function unpairMachine(
  context: Context,
  userId: string,
  machineId: string,
): Promise<void> {
  if (!isUuid(machineId))
    throw new ApiError(404, "not_found", "You have no such Machine.");
  const lost = await transaction(context.db, async (tx) => {
    // The Tickets of its running Runs are locked first, in the order everything that ends a Run locks them.
    const { rows: held } = await tx.query<{
      id: string;
      workspaceId: string;
      projectId: string;
    }>(
      `select tickets.id, tickets.workspace_id as "workspaceId", tickets.project_id as "projectId"
       from local_runs join runs on runs.id = local_runs.run_id and runs.state = 'running'
       join tickets on tickets.id = runs.ticket_id
       join machines on machines.id = local_runs.machine_id and machines.owner_id = $2
       where local_runs.machine_id = $1 order by tickets.id for update of tickets`,
      [machineId, userId],
    );
    const now = context.clock.now();
    const { rows } = await tx.query<{ name: string }>(
      "update machines set revoked_at = $3, token_hash = null where id = $1 and owner_id = $2 and revoked_at is null returning name",
      [machineId, userId, now],
    );
    if (!rows[0])
      throw new ApiError(404, "not_found", "You have no such Machine.");
    for (const ticket of held) {
      await stopRunningRun(
        context,
        tx,
        ticket.id,
        `${rows[0].name}, the Machine running it, was unpaired.`,
        now,
      );
      context.live.publish(tx, ticket.workspaceId, {
        type: "ticket.changed",
        projectId: ticket.projectId,
        ticketId: ticket.id,
      });
    }
    await tx.query(
      "update local_runs set stop_acked_at = $2 where machine_id = $1 and stop_acked_at is null",
      [machineId, now],
    );
    // Its lost Runs can't come back without it: their tokens go too.
    const { rows: lostRuns } = await tx.query<{ runId: string }>(
      `select local_runs.run_id as "runId" from local_runs join runs on runs.id = local_runs.run_id
       where local_runs.machine_id = $1 and runs.state = 'lost' and local_runs.revoked_at is null`,
      [machineId],
    );
    return lostRuns;
  });
  for (const { runId } of lost) await revokeLocalRunToken(context, runId);
  context.live.endMachines((stream) => stream.machineId === machineId);
}

/** What a Machine's daemon learns about itself from its token. */
export const MachineSelf = Type.Object({
  id: Type.String({ format: "uuid" }),
  name: Type.String(),
  owner: Type.Object({
    id: Type.String({ format: "uuid" }),
    email: Type.Union([Type.String(), Type.Null()]),
  }),
  runners: Type.Array(
    Type.Object({ id: Type.String({ format: "uuid" }), name: Type.String() }),
    {
      description: "The `local` Runners it serves.",
    },
  ),
});
export type MachineSelf = Static<typeof MachineSelf>;

const invalidMachineToken = () =>
  new ApiError(
    401,
    "invalid_machine_token",
    "That Machine token was revoked, as unpairing does, or never existed: run `cronk-runner login` again.",
  );

/** A header's value as one trimmed string, if the request has it. */
function header(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return first?.trim() ? first.trim().slice(0, 50) : null;
}

/**
 * The Machine whose token the request carries as `Authorization: Bearer …`, recording its contact and the version and
 * limit its daemon announces (`X-Cronk-Runner-Version`, `X-Cronk-Runner-Limit`), so a changed config takes effect
 * without pairing again. A token of an unpaired Machine, or none, is refused with `invalid_machine_token`; a daemon
 * older than `minDaemonVersion` with `daemon_too_old`, its version recorded so its User sees what to upgrade.
 */
export async function requireMachine(
  context: Context,
  request: FastifyRequest,
): Promise<MachineSelf> {
  const secret = /^Bearer\s+(\S+)\s*$/i.exec(
    request.headers.authorization ?? "",
  )?.[1];
  if (!secret) throw invalidMachineToken();
  const version = header(request, daemonVersionHeader);
  const announced = Number(header(request, machineLimitHeader) ?? Number.NaN);
  const limit =
    Number.isInteger(announced) && announced >= 1 && announced <= 100
      ? announced
      : null;
  const { rows } = await context.db.query<{
    id: string;
    daemonVersion: string;
  }>(
    `update machines set last_contact_at = $2, daemon_version = coalesce($3, daemon_version), run_limit = coalesce($4, run_limit)
     where token_hash = $1 and revoked_at is null returning id, daemon_version as "daemonVersion"`,
    [hashSecret(secret), context.clock.now(), version, limit],
  );
  if (!rows[0]) throw invalidMachineToken();
  if (isTooOld(rows[0].daemonVersion))
    throw daemonTooOld(rows[0].daemonVersion);
  const { rows: found } = await context.db.query<MachineSelf>(
    `select machines.id, machines.name, json_build_object('id', users.id, 'email', users.email) as owner,
       coalesce((select json_agg(json_build_object('id', runners.id, 'name', runners.name) order by lower(runners.name), runners.id)
         from machine_runners join runners on runners.id = machine_runners.runner_id
         where machine_runners.machine_id = machines.id), '[]') as runners
     from machines join users on users.id = machines.owner_id where machines.id = $1`,
    [rows[0].id],
  );
  return found[0]!;
}

/**
 * Records that the Machine's daemon opened its event stream. Its first stream brings its Runners online: their Owner
 * hears they changed, and once that commits, their waiting Tickets start in queue order, highest Priority first.
 */
export async function machineConnected(
  context: Context,
  machine: MachineSelf,
): Promise<void> {
  const runnerIds = machine.runners.map((r) => r.id);
  await transaction(context.db, async (tx) => {
    // The Runners first, as starting a Run locks them: a Ticket rechecked meanwhile sees the connection, or is seen waiting.
    await tx.query(
      "select 1 from runners where id = any($1::uuid[]) order by id for update",
      [runnerIds],
    );
    const { rows } = await tx.query<{ connections: number }>(
      "update machines set connections = connections + 1 where id = $1 returning connections",
      [machine.id],
    );
    if (rows[0]?.connections !== 1) return;
    for (const runnerId of runnerIds)
      context.live.publishToOwner(tx, machine.owner.id, {
        type: "runner.changed",
        runnerId,
      });
    afterCommit(tx, async () => {
      for (const runnerId of runnerIds)
        await startWaitingRuns(context, runnerId);
    });
  });
}

/**
 * Records that one of the Machine's streams closed. Its last one takes its Runners offline unless another Machine
 * serves them: their Owner hears they changed. Runs it was told of stay claimable; only new ones wait.
 */
export async function machineDisconnected(
  context: Context,
  machine: MachineSelf,
): Promise<void> {
  await transaction(context.db, async (tx) => {
    const { rows } = await tx.query<{ connections: number }>(
      `update machines set connections = greatest(connections - 1, 0),
         disconnected_at = case when connections <= 1 then $2 else disconnected_at end
       where id = $1 returning connections`,
      [machine.id, context.clock.now()],
    );
    if (rows[0]?.connections !== 0) return;
    for (const { id } of machine.runners)
      context.live.publishToOwner(tx, machine.owner.id, {
        type: "runner.changed",
        runnerId: id,
      });
  });
}

/** Forgets the connections a server that stopped left counted: none of its streams outlived it. */
export async function forgetConnections(db: Db, now: Date): Promise<void> {
  await db.query(
    "update machines set connections = 0, disconnected_at = $1 where connections > 0",
    [now],
  );
}
