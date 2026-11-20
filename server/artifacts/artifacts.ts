import { randomBytes, randomUUID } from "node:crypto";
import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { afterCommit, transaction, type Db, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import { isUuid } from "../http/ids.js";
import type { Caller } from "../identity/callers.js";
import { inView, type Viewer } from "../identity/viewers.js";
import type { Place } from "../knowledge/places.js";
import { outdatedVersion } from "../knowledge/versions.js";
import { Actor, actorColumn } from "../work/actors.js";
import { describeSize, forgetAttachments } from "../attachments/attachments.js";
import { ownerName } from "../agents/tokens.js";
import { findTicketRow, runningRunOf, runOfAgent } from "../work/tickets.js";
import { insertLink } from "./linked-artifacts.js";
import { ComparedLine, compareWords } from "../knowledge/compare.js";

/**
 * Artifacts: live pages an Actor builds, such as an HTML prototype, with the files the page refers to by relative
 * paths, kept in a Project or the Workspace. Each save makes a Version holding the whole set of files, served from its
 * own unguessable address in the browser's sandbox, so the page never acts as the signed-in User (ADR 0004).
 */

export const ArtifactFile = Type.Object({
  path: Type.String({ description: "Its path relative to the Version, such as `index.html` or `scripts/app.js`." }),
  mediaType: Type.String({ description: "The media type it is served with, such as `text/html`." }),
  size: Type.Integer({ minimum: 0, description: "In bytes." }),
});
export type ArtifactFile = Static<typeof ArtifactFile>;

/** One saved state of an Artifact, without its files. */
export const ArtifactVersion = Type.Object({
  number: Type.Integer({ minimum: 1, description: "Counts up from 1 with each save of the Artifact." }),
  actor: Actor,
  savedAt: Type.String({ format: "date-time" }),
});
export type ArtifactVersion = Static<typeof ArtifactVersion>;

export const Artifact = Type.Object({
  id: Type.String({ format: "uuid" }),
  workspaceId: Type.String({ format: "uuid" }),
  projectId: Type.Union([Type.String({ format: "uuid" }), Type.Null()], {
    description: "The Project it is kept in, or null for the Workspace.",
  }),
  title: Type.String(),
  description: Type.String(),
  page: Type.String({ description: "The path of the file that is its page." }),
  url: Type.String({
    description:
      "Where its page is served, on Cronk's own address, sandboxed: open it, or show it in an iframe with " +
      "`sandbox=\"allow-scripts\"`. The address is unguessable and needs no sign-in, so its relative paths resolve " +
      "within the Version; each Version has its own.",
  }),
  version: Type.Object(ArtifactVersion.properties, { description: "The current Version, which a save names as its base." }),
  files: Type.Array(ArtifactFile, { description: "The current Version's files, by path." }),
});
export type Artifact = Static<typeof Artifact>;

/** A file as a create or save gives it. */
export interface FileInput {
  path: string;
  contentBase64: string;
  mediaType?: string;
}

/** Where a Version's files are served, by its key: each file at its relative path under it. */
export const sandboxPath = (key: string, path = "") => `/sandbox/${key}/${path.split("/").map(encodeURIComponent).join("/")}`;

type Row = Omit<Artifact, "url" | "files" | "version"> & {
  serveKey: string;
  version: Omit<ArtifactVersion, "savedAt"> & { savedAt: string };
  files: ArtifactFile[] | null;
};

const columns = `artifacts.id, artifacts.workspace_id as "workspaceId", artifacts.project_id as "projectId",
  versions.title, versions.description, versions.page, versions.serve_key as "serveKey",
  json_build_object('number', versions.number, 'actor', ${actorColumn("users", "agents")}, 'savedAt', versions.saved_at)
    as version,
  (select json_agg(json_build_object('path', files.path, 'mediaType', files.media_type, 'size', files.size)
     order by files.path collate "C")
   from artifact_files files where files.artifact_id = artifacts.id and files.version = artifacts.version) as files`;

const fromArtifacts = `artifacts
  join artifact_versions versions on versions.artifact_id = artifacts.id and versions.number = artifacts.version
  left join users on users.id = versions.actor_user_id
  left join agents on agents.id = versions.actor_agent_id`;

const present = ({ serveKey, ...row }: Row): Artifact => ({
  ...row,
  url: sandboxPath(serveKey, row.page),
  version: { ...row.version, savedAt: new Date(row.version.savedAt).toISOString() },
  files: (row.files ?? []).map((file) => ({ ...file, size: Number(file.size) })),
});

export function artifactNotFound(): ApiError {
  return new ApiError(404, "not_found", "No such Artifact.");
}

/** An Artifact in the Viewer's view, at its current Version; otherwise nothing, as if it didn't exist. */
export async function findArtifact(db: Db | Tx, viewer: Viewer, artifactId: string): Promise<Artifact | undefined> {
  if (!isUuid(artifactId)) return undefined;
  const view = inView(viewer, "artifacts.workspace_id", "$2");
  const { rows } = await db.query<Row>(`select ${columns} from ${fromArtifacts} where artifacts.id = $1 and ${view.sql}`, [
    artifactId,
    view.value,
  ]);
  return rows[0] && present(rows[0]);
}

const mediaTypes: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  js: "text/javascript",
  mjs: "text/javascript",
  css: "text/css",
  json: "application/json",
  map: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  xml: "application/xml",
  wasm: "application/wasm",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
  pdf: "application/pdf",
};

/** A file's media type: the one given, else the one its extension names, else `application/octet-stream`. */
function mediaTypeOf(path: string, given: string | undefined): string {
  const type = given?.split(";")[0]?.trim().toLowerCase();
  if (type && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(type)) return type;
  const extension = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? "";
  return mediaTypes[extension] ?? "application/octet-stream";
}

/** A file as kept: its path, media type, size, and the id its bytes are kept under. */
interface Kept {
  path: string;
  mediaType: string;
  size: number;
  blobId: string;
}

/**
 * Refuses a path that doesn't stay within the Version: each of its parts a name, never empty, `.` or `..`, with no
 * backslash and nothing a browser would read as more than a path.
 */
function checkPath(path: string): void {
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..") || /[\\?#%\u0000-\u001f\u007f]/.test(path)) {
    throw new ApiError(400, "invalid_path", `${JSON.stringify(path)} isn't a path within the Artifact.`, {
      rule: "An Artifact's files have paths relative to its Version, such as `index.html` or `scripts/app.js`: names " +
        "joined by `/`, with no empty, `.` or `..` part, and no `\\`, `?`, `#` or `%`.",
      advice: "Give the file a path relative to the page, without leading `/`, and refer to it by that path.",
    });
  }
}

/** A file's bytes from its base64, or a refusal when it isn't standard base64. */
function decodeBase64(file: FileInput): Buffer {
  const content = file.contentBase64.replace(/\s/g, "");
  if (content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) {
    throw new ApiError(400, "invalid_base64", `${file.path}'s \`contentBase64\` isn't base64.`, {
      rule: "A file's bytes are given in standard base64, padded with `=`.",
      advice: "Encode the file's bytes as base64, for example with `base64 -w0 <file>`, and save again.",
    });
  }
  return Buffer.from(content, "base64");
}

/** Refuses a Version whose files are over the Attachments size limit in all, naming it. */
export function artifactTooLarge(limitBytes: number): ApiError {
  const limit = describeSize(limitBytes);
  return new ApiError(413, "artifact_too_large", `An Artifact's files may be at most ${limit} in all.`, {
    rule: `Each Version of an Artifact holds at most ${limit} of files in all, the Attachments size limit Cronk is configured with.`,
    advice: "Make the files smaller: minify or compress them, load libraries from a CDN, or drop files the page doesn't use.",
  });
}

/** Refuses a Version whose files are over the limit in all, or whose page isn't among them. */
function checkVersion(content: { page: string; files: Kept[] }, limitBytes: number): void {
  if (content.files.reduce((total, file) => total + file.size, 0) > limitBytes) throw artifactTooLarge(limitBytes);
  if (!content.files.some((file) => file.path === content.page)) {
    throw new ApiError(400, "page_missing", `The Artifact's page, ${content.page}, isn't among its files.`, {
      rule: "An Artifact's page is one of its files: `page` names it, `index.html` unless given.",
      advice: "Add the page as one of the files, or set `page` to the path of the file that is the page.",
    });
  }
}

/** Records a Version of the Artifact with its whole set of files, numbered, by its Actor. */
async function insertVersion(
  tx: Tx,
  artifact: { id: string; workspaceId: string },
  number: number,
  content: { title: string; description: string; page: string; files: Kept[] },
  actor: { kind: "user" | "agent"; id: string },
  now: Date,
): Promise<void> {
  await tx.query(
    `insert into artifact_versions (artifact_id, number, workspace_id, title, description, page, serve_key, actor_user_id,
       actor_agent_id, saved_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      artifact.id,
      number,
      artifact.workspaceId,
      content.title.trim(),
      content.description,
      content.page,
      randomBytes(24).toString("base64url"),
      actor.kind === "user" ? actor.id : null,
      actor.kind === "agent" ? actor.id : null,
      now,
    ],
  );
  for (const file of content.files) {
    await tx.query(
      `insert into artifact_files (artifact_id, version, path, media_type, size, blob_id) values ($1, $2, $3, $4, $5, $6)`,
      [artifact.id, number, file.path, file.mediaType, file.size, file.blobId],
    );
  }
}

/**
 * Keeps the bytes of the given files in the Attachment storage, each under a new id, and runs `work` with them; if
 * `work` fails, the bytes are forgotten again, since nothing refers to them.
 */
async function keepingFiles<T>(context: Context, files: FileInput[], work: (kept: Kept[]) => Promise<T>): Promise<T> {
  const seen = new Set<string>();
  for (const file of files) {
    checkPath(file.path);
    if (seen.has(file.path)) {
      throw new ApiError(400, "repeated_path", `${file.path} is given more than once.`, {
        rule: "Each of an Artifact's files has its own path.",
        advice: "Give each file once, at one path.",
      });
    }
    seen.add(file.path);
  }
  const decoded = files.map((file) => ({ ...file, bytes: decodeBase64(file) }));
  const limit = context.config.attachments.limitBytes;
  if (decoded.reduce((total, file) => total + file.bytes.length, 0) > limit) throw artifactTooLarge(limit);
  const kept: Kept[] = [];
  try {
    for (const file of decoded) {
      const blobId = randomUUID();
      kept.push({ path: file.path, mediaType: mediaTypeOf(file.path, file.mediaType), size: file.bytes.length, blobId });
      await context.attachments.put(blobId, file.bytes);
    }
    return await work(kept);
  } catch (error) {
    await Promise.all(kept.map((file) => context.attachments.delete(file.blobId).catch(() => {})));
    throw error;
  }
}

/**
 * Creates an Artifact in the Project or the Workspace, at Version 1 by its Actor, with its page and files. An Agent
 * creating it during its running Run names the Run, and the Artifact is linked to the Run's Ticket.
 */
export async function createArtifact(
  context: Context,
  actor: Caller,
  place: Place,
  input: { title: string; description?: string; page?: string; files: FileInput[]; runId?: string },
): Promise<Artifact> {
  const { db, clock } = context;
  if (input.runId !== undefined && actor.kind === "user") {
    throw new ApiError(400, "run_for_agents", "Only an Agent names the Run it creates an Artifact in.");
  }
  return keepingFiles(context, input.files, (files) =>
    transaction(db, async (tx) => {
      const run =
        input.runId !== undefined && actor.kind === "agent"
          ? await runningRunOf(tx, actor, input.runId, {
              rule: "An Agent creates an Artifact in a Run only while that Run of its own is running.",
              advice: "Name your running Run, as your Brief gives it, or leave the Run out to create the Artifact linked to no Ticket.",
            })
          : null;
      const now = clock.now();
      const { rows } = await tx.query<{ id: string }>(
        `insert into artifacts (workspace_id, project_id, version, created_at) values ($1, $2, 1, $3) returning id`,
        [place.workspaceId, place.projectId, now],
      );
      const id = rows[0]!.id;
      const content = { title: input.title, description: input.description ?? "", page: input.page ?? "index.html", files };
      checkVersion(content, context.config.attachments.limitBytes);
      await insertVersion(tx, { id, workspaceId: place.workspaceId }, 1, content, actor, now);
      context.live.publish(tx, place.workspaceId, { type: "artifact.changed", projectId: place.projectId, artifactId: id });
      const created = (await findArtifact(tx, actor, id))!;
      if (run && actor.kind === "agent") {
        const ticket = (await findTicketRow(tx, actor, run.ticketId, { lock: true }))!;
        // Asked again under the Ticket's lock, so a Run stopped meanwhile, as by a move, refuses the create.
        const runId = await runOfAgent(tx, actor, ticket);
        await insertLink(context, tx, ticket, { kind: "agent", id: actor.id, runId }, created);
      }
      return created;
    }),
  );
}

/** A served file: the bytes of a Version's file at the path, by the Version's key. */
export interface ServedFile {
  mediaType: string;
  size: number;
  blobId: string;
}

/**
 * The file at the path of the Version served under the key, or, for no path, where the Version's page is; otherwise
 * nothing. The key is all it takes, so the sandboxed page's own requests, which carry no sign-in, reach its files.
 */
export async function servedFile(db: Db, key: string, path: string): Promise<ServedFile | { page: string } | undefined> {
  const { rows } = await db.query<ServedFile & { page: string }>(
    `select versions.page, files.media_type as "mediaType", files.size, files.blob_id as "blobId"
     from artifact_versions versions
     left join artifact_files files
       on files.artifact_id = versions.artifact_id and files.version = versions.number and files.path = $2
     where versions.serve_key = $1`,
    [key, path],
  );
  const row = rows[0];
  if (!row) return undefined;
  if (path === "") return { page: row.page };
  return row.blobId ? { mediaType: row.mediaType, size: Number(row.size), blobId: row.blobId } : undefined;
}

export interface ArtifactSave {
  /** The number of the Version the save is based on. */
  baseVersion?: number;
  title?: string;
  description?: string;
  page?: string;
  /** Files to add, or to replace at their paths. */
  files?: FileInput[];
  /** Paths of files to remove. */
  remove?: string[];
}

/**
 * Saves an Artifact as its next Version by the Actor, holding the whole set of files: the current Version's, with
 * those given added or replaced and those named removed. A save must be based on the current Version: one based on
 * an outdated Version is refused with the current Version, so its Actor can see what changed.
 */
export async function saveArtifact(context: Context, actor: Caller, artifactId: string, save: ArtifactSave): Promise<Artifact> {
  const { db, clock } = context;
  return keepingFiles(context, save.files ?? [], (added) =>
    transaction(db, async (tx) => {
      const current = await lockArtifact(tx, actor, artifactId);
      if (!current) throw artifactNotFound();
      if (save.baseVersion === undefined) {
        throw new ApiError(400, "base_version_needed", "A save names the Version it's based on, as `baseVersion`.", {
          rule: "A save names the Version it's based on, so it never overwrites a change its Actor hasn't seen.",
          advice: "Read the Artifact and save again with `baseVersion` set to its current Version's number.",
        });
      }
      if (save.baseVersion !== current.version.number) throw outdatedVersion("Artifact", current.version, save.baseVersion);
      for (const path of save.remove ?? []) checkPath(path);
      const removed = new Set(save.remove ?? []);
      const replaced = new Set(added.map((file) => file.path));
      const kept = (await keptFiles(tx, current.id, current.version.number)).filter(
        (file) => !removed.has(file.path) && !replaced.has(file.path),
      );
      const number = current.version.number + 1;
      const content = {
        title: save.title ?? current.title,
        description: save.description ?? current.description,
        page: save.page ?? current.page,
        files: [...kept, ...added],
      };
      checkVersion(content, context.config.attachments.limitBytes);
      await insertVersion(tx, current, number, content, actor, clock.now());
      await tx.query("update artifacts set version = $2 where id = $1", [current.id, number]);
      context.live.publish(tx, current.workspaceId, { type: "artifact.changed", projectId: current.projectId, artifactId: current.id });
      return (await findArtifact(tx, actor, current.id))!;
    }),
  );
}

/**
 * Deletes the Artifact with all its Versions, their files' bytes once the delete is committed. Only a User may, so an
 * agent can't remove work. It drops out of its links, and the Tickets linking it show the change.
 */
export async function deleteArtifact(context: Context, actor: Caller, artifactId: string): Promise<void> {
  const { db, live } = context;
  await transaction(db, async (tx) => {
    const artifact = await lockArtifact(tx, actor, artifactId);
    if (!artifact) throw artifactNotFound();
    if (actor.kind === "agent") {
      throw new ApiError(403, "agent_not_allowed", `${actor.name} is an Agent, and only a User can delete an Artifact.`, {
        rule: "Only a User deletes an Artifact, so an agent can't remove work.",
        advice: `Leave the Artifact as it is, or save a new Version; ask ${ownerName(actor)}, ${actor.name}'s Owner, if it should go.`,
      });
    }
    const linking = await tx.query<{ ticketId: string; projectId: string }>(
      `select tickets.id as "ticketId", tickets.project_id as "projectId"
       from linked_artifacts join tickets on tickets.id = linked_artifacts.ticket_id
       where linked_artifacts.artifact_id = $1 order by linked_artifacts.seq`,
      [artifact.id],
    );
    for (const { ticketId, projectId } of linking.rows) {
      live.publish(tx, artifact.workspaceId, { type: "ticket.changed", projectId, ticketId });
    }
    const blobs = await tx.query<{ blobId: string }>(
      `select distinct blob_id as "blobId" from artifact_files where artifact_id = $1`,
      [artifact.id],
    );
    // Its Versions, their files and its links go with it.
    await tx.query("delete from artifacts where id = $1", [artifact.id]);
    afterCommit(tx, () => forgetAttachments(context, blobs.rows.map((row) => row.blobId)));
    live.publish(tx, artifact.workspaceId, { type: "artifact.changed", projectId: artifact.projectId, artifactId: artifact.id });
  });
}

/** The Artifact at its current Version, its row locked until the transaction ends, so saves of it queue up. */
async function lockArtifact(tx: Tx, viewer: Viewer, artifactId: string): Promise<Artifact | undefined> {
  if (!isUuid(artifactId)) return undefined;
  const view = inView(viewer, "workspace_id", "$2");
  const { rowCount } = await tx.query(`select 1 from artifacts where id = $1 and ${view.sql} for update`, [
    artifactId,
    view.value,
  ]);
  return rowCount ? findArtifact(tx, viewer, artifactId) : undefined;
}

/** A Version's files as kept, or only the one at the path. */
async function keptFiles(db: Db | Tx, artifactId: string, version: number, path?: string): Promise<Kept[]> {
  const { rows } = await db.query<Kept>(
    `select path, media_type as "mediaType", size, blob_id as "blobId" from artifact_files
     where artifact_id = $1 and version = $2 and ($3::text is null or path = $3)`,
    [artifactId, version, path ?? null],
  );
  return rows.map((row) => ({ ...row, size: Number(row.size) }));
}

export const ArtifactSummary = Type.Omit(Artifact, ["files"]);
export type ArtifactSummary = Static<typeof ArtifactSummary>;

/** The Artifacts kept in the Project or the Workspace, last changed first, without their files. */
export async function artifactsIn(db: Db, place: Place): Promise<ArtifactSummary[]> {
  const { rows } = await db.query<Row>(
    `select ${columns} from ${fromArtifacts}
     where artifacts.workspace_id = $1 and artifacts.project_id is not distinct from $2
     order by versions.saved_at desc, artifacts.id`,
    [place.workspaceId, place.projectId],
  );
  return rows.map((row) => {
    const { files: _files, ...summary } = present(row);
    return summary;
  });
}

export const ArtifactFileContent = Type.Object({
  ...ArtifactFile.properties,
  contentBase64: Type.String({ description: "The file's bytes, in base64." }),
});
export type ArtifactFileContent = Static<typeof ArtifactFileContent>;

/** A file of the Artifact's current Version with its bytes. */
export async function readArtifactFile(context: Context, viewer: Viewer, artifactId: string, path: string): Promise<ArtifactFileContent> {
  const artifact = await findArtifact(context.db, viewer, artifactId);
  if (!artifact) throw artifactNotFound();
  const [file] = await keptFiles(context.db, artifact.id, artifact.version.number, path);
  if (!file) throw new ApiError(404, "not_found", `${artifact.title} has no file ${path}.`);
  const bytes = await bytesOf(context, file);
  return { path: file.path, mediaType: file.mediaType, size: file.size, contentBase64: bytes.toString("base64") };
}

/** A kept file's bytes, or a refusal when Cronk's storage has lost them. */
async function bytesOf(context: Context, file: Kept): Promise<Buffer> {
  const content = await context.attachments.get(file.blobId);
  if (!content) throw new ApiError(404, "artifact_file_missing", `${file.path}'s bytes are missing from Cronk's storage.`);
  const chunks: Buffer[] = [];
  for await (const chunk of content) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

type VersionRow = Omit<ArtifactVersion, "savedAt"> & { savedAt: Date };

/** The Versions of an Artifact already found in the caller's view, oldest first. */
async function versionsOfFound(db: Db, artifactId: string): Promise<ArtifactVersion[]> {
  const { rows } = await db.query<VersionRow>(
    `select versions.number, ${actorColumn("users", "agents")} as actor, versions.saved_at as "savedAt"
     from artifact_versions versions
     left join users on users.id = versions.actor_user_id
     left join agents on agents.id = versions.actor_agent_id
     where versions.artifact_id = $1 order by versions.number`,
    [artifactId],
  );
  return rows.map((row) => ({ ...row, savedAt: row.savedAt.toISOString() }));
}

/** An Artifact's Versions, oldest first, each with the Actor who saved it and when, without their files. */
export async function artifactVersionsOf(db: Db, viewer: Viewer, artifactId: string): Promise<ArtifactVersion[]> {
  const artifact = await findArtifact(db, viewer, artifactId);
  if (!artifact) throw artifactNotFound();
  return versionsOfFound(db, artifact.id);
}

export const ComparedFile = Type.Object({
  path: Type.String(),
  change: Type.Union([Type.Literal("added"), Type.Literal("removed"), Type.Literal("changed")], {
    description: "Whether the file is only in the later Version, only in the earlier one, or in both with other bytes.",
  }),
  text: Type.Boolean({ description: "Whether the file is text, UTF-8 without NUL bytes; only text is compared by line." }),
  lines: Type.Array(ComparedLine, {
    description: "Its text compared line by line, in order: all added or all removed for a file added or removed; " +
      "empty for a file that isn't text.",
  }),
});
export type ComparedFile = Static<typeof ComparedFile>;

export const ArtifactComparison = Type.Object({
  from: ArtifactVersion,
  to: ArtifactVersion,
  files: Type.Array(ComparedFile, { description: "The files that differ, by path; those that didn't change are left out." }),
});
export type ArtifactComparison = Static<typeof ArtifactComparison>;

/** A file's bytes as text, when they are UTF-8 without NUL bytes; otherwise nothing. */
function textOf(bytes: Buffer): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * A file's text as lines: `\r\n` ends a line as `\n` does, the newline ending the last line starts no further one,
 * and an empty file has none.
 */
const linesOf = (text: string) => (text === "" ? [] : text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n"));

/**
 * Two of an Artifact's Versions: each file added, removed or changed from one to the other, by path, its text
 * compared line by line.
 */
export async function compareArtifactVersions(
  context: Context,
  viewer: Viewer,
  artifactId: string,
  numbers: { from: number; to: number },
): Promise<ArtifactComparison> {
  const artifact = await findArtifact(context.db, viewer, artifactId);
  if (!artifact) throw artifactNotFound();
  const versions = await versionsOfFound(context.db, artifact.id);
  const version = (number: number) => {
    const found = versions.find((v) => v.number === number);
    if (!found) throw new ApiError(404, "not_found", `${artifact.title} has no Version ${number}.`);
    return found;
  };
  const [from, to] = [version(numbers.from), version(numbers.to)];
  const filesOf = async (number: number) =>
    new Map((await keptFiles(context.db, artifact.id, number)).map((file) => [file.path, file]));
  const [filesBefore, filesAfter] = [await filesOf(from.number), await filesOf(to.number)];
  const paths = [...new Set([...filesBefore.keys(), ...filesAfter.keys()])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const files: ComparedFile[] = [];
  for (const path of paths) {
    const [before, after] = [filesBefore.get(path), filesAfter.get(path)];
    if (before && after && before.blobId === after.blobId) continue;
    const bytesBefore = before ? await bytesOf(context, before) : Buffer.alloc(0);
    const bytesAfter = after ? await bytesOf(context, after) : Buffer.alloc(0);
    if (before && after && bytesBefore.equals(bytesAfter)) continue;
    // A side the file is missing from reads as empty text.
    const [textBefore, textAfter] = [textOf(bytesBefore), textOf(bytesAfter)];
    const text = textBefore !== undefined && textAfter !== undefined;
    files.push({
      path,
      change: !before ? "added" : !after ? "removed" : "changed",
      text,
      lines: text ? compareWords(linesOf(textBefore), linesOf(textAfter)) : [],
    });
  }
  return { from, to, files };
}
