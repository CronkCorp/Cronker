import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Context } from "../context.js";
import type { Db } from "../db.js";
import { requireCaller } from "../identity/callers.js";
import { inReach, inView, type Viewer } from "../identity/viewers.js";
import { ApiError } from "./errors.js";
import { isUuid } from "./ids.js";

/**
 * Readable forms: what the web client's addresses name things by, which the API takes wherever it takes their ids.
 * Each resolves among what the caller sees, trying every way the form could be read; a form that could name more than
 * one thing names none, as an unknown id does, rather than picking one.
 *
 * - A Workspace: its slug, such as `acme`, in any letter case.
 * - A Project: its key, such as `RP`, or `acme/RP`.
 * - A Ticket: its key, such as `RP-12`, or `acme/RP-12`, in any letter case.
 * - A Decision: its number within its Project (`RP/3`) or among the Workspace's own (`3`), either also after
 *   `acme/`.
 * - A Term: its name within its Project's glossary (`RP/Ticket`) or the Workspace's (`Ticket`), ignoring case,
 *   either also after `acme/`.
 * - A Document, Artifact or Transcript: its slug, such as `onboarding-3f9a1b2c`, whose end is the start of its id
 *   (its short id); the words before it may be anything, and the id itself works as well.
 */
export type ReadableKind = "workspace" | "project" | "ticket" | "decision" | "term" | "document" | "artifact" | "transcript";

/** The path parameters that take each kind's id. */
const parameterKinds: Record<string, ReadableKind> = {
  workspaceId: "workspace",
  projectId: "project",
  ticketId: "ticket",
  decisionId: "decision",
  termId: "term",
  documentId: "document",
  artifactId: "artifact",
  transcriptId: "transcript",
};

/** Body fields taking an id, per route, beyond its path parameters. */
const bodyKinds: Record<string, Record<string, ReadableKind>> = {
  "POST /api/projects/:projectId/tickets": { parentId: "ticket" },
  "POST /api/tickets/:ticketId/relations": { ticketId: "ticket" },
  "POST /api/tickets/:ticketId/duplicate": { ticketId: "ticket" },
  "POST /api/tickets/:ticketId/documents": { documentId: "document" },
  "POST /api/tickets/:ticketId/artifacts": { artifactId: "artifact" },
  "POST /api/workspaces/:workspaceId/documents": { parentId: "document" },
  "POST /api/projects/:projectId/documents": { parentId: "document" },
  "PATCH /api/documents/:documentId": { parentId: "document" },
  "POST /api/workspaces/:workspaceId/decisions": { supersededById: "decision" },
  "POST /api/projects/:projectId/decisions": { supersededById: "decision" },
  "PATCH /api/decisions/:decisionId": { supersededById: "decision" },
};

/**
 * Rewrites the readable forms a request names things by into their ids before the route reads them, so every route
 * taking an id takes the readable form too. A form naming nothing is left as it is, for the route to answer as it
 * does an unknown id.
 */
export function acceptReadableForms(app: FastifyInstance, context: Context): void {
  app.addHook("preValidation", async (request) => {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const route = `${request.method} ${request.routeOptions.url ?? ""}`;
    const body = request.body && typeof request.body === "object" ? (request.body as Record<string, unknown>) : {};
    const named: [Record<string, unknown>, string, ReadableKind][] = [
      ...Object.entries(parameterKinds).map(([name, kind]) => [params, name, kind] as [Record<string, unknown>, string, ReadableKind]),
      ...Object.entries(bodyKinds[route] ?? {}).map(([name, kind]) => [body, name, kind] as [Record<string, unknown>, string, ReadableKind]),
    ];
    const readable = named.filter(([holder, name]) => typeof holder[name] === "string" && !isUuid(holder[name] as string));
    if (readable.length === 0) return;
    const viewer = await viewerOf(context, request);
    if (!viewer) return;
    for (const [holder, name, kind] of readable) {
      const id = await resolveReadable(context.db, viewer, kind, holder[name] as string);
      if (id) holder[name] = id;
    }
  });
}

/** Whoever makes the request as a Viewer, if anyone is signed in; the route itself refuses anyone else. */
async function viewerOf(context: Context, request: FastifyRequest): Promise<Viewer | undefined> {
  try {
    return await requireCaller(context, request);
  } catch (error) {
    if (error instanceof ApiError) return undefined;
    throw error;
  }
}

/** The id of the one thing of the kind a readable form names among what the Viewer sees, if it names exactly one. */
export async function resolveReadable(db: Db, viewer: Viewer, kind: ReadableKind, form: string): Promise<string | undefined> {
  if (isUuid(form)) return form;
  const ids = new Set<string>();
  for (const reading of readings(kind, form)) {
    for (const id of await reading(db, viewer)) ids.add(id);
    if (ids.size > 1) return undefined;
  }
  return ids.size === 1 ? [...ids][0] : undefined;
}

type Reading = (db: Db, viewer: Viewer) => Promise<string[]>;

/** Every way a readable form of the kind could be read, each finding what it names. */
function readings(kind: ReadableKind, form: string): Reading[] {
  const parts = form.split("/");
  const [first, second] = parts;
  const after = (n: number) => parts.slice(n).join("/");
  switch (kind) {
    case "workspace":
      return [(db, viewer) => workspaces(db, viewer, form)];
    case "project":
      return [
        (db, viewer) => projects(db, viewer, null, form),
        ...(parts.length === 2 ? [(db: Db, viewer: Viewer) => projects(db, viewer, first!, second!)] : []),
      ];
    case "ticket":
      return [
        (db, viewer) => tickets(db, viewer, null, form),
        ...(parts.length === 2 ? [(db: Db, viewer: Viewer) => tickets(db, viewer, first!, second!)] : []),
      ];
    case "decision":
    case "term": {
      const find = kind === "decision" ? decisions : terms;
      const found: Reading[] = [(db, viewer) => find(db, viewer, null, null, form)];
      if (parts.length >= 2) {
        found.push((db, viewer) => find(db, viewer, first!, null, after(1)));
        found.push((db, viewer) => find(db, viewer, null, first!, after(1)));
      }
      if (parts.length >= 3) found.push((db, viewer) => find(db, viewer, first!, second!, after(2)));
      return found;
    }
    case "document":
    case "artifact":
    case "transcript":
      return [(db, viewer) => bySlug(db, viewer, kind, form)];
  }
}

/**
 * The SQL condition, with its parameter, that a Workspace column is in view, or, given the column of the record's
 * Project, that the record is in reach; and, given a slug, that the Workspace is that one.
 */
function workspaceCondition(viewer: Viewer, column: string, slug: string | null, params: unknown[], projectColumn?: string): string {
  const param = `$${params.length + 1}`;
  const view = projectColumn ? inReach(viewer, { project: projectColumn, workspace: column }, param) : inView(viewer, column, param);
  params.push(view.value);
  if (slug === null) return view.sql;
  params.push(slug);
  return `${view.sql} and ${column} = (select id from workspaces where slug = lower($${params.length}))`;
}

async function ids(db: Db, sql: string, params: unknown[]): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(sql, params);
  return rows.map((row) => row.id);
}

function workspaces(db: Db, viewer: Viewer, slug: string): Promise<string[]> {
  const params: unknown[] = [slug];
  return ids(db, `select id from workspaces where slug = lower($1) and ${workspaceCondition(viewer, "workspaces.id", null, params)}`, params);
}

function projects(db: Db, viewer: Viewer, slug: string | null, key: string): Promise<string[]> {
  const params: unknown[] = [key];
  return ids(
    db,
    `select id from projects where lower(key) = lower($1) and ${workspaceCondition(viewer, "projects.workspace_id", slug, params, "projects.id")}`,
    params,
  );
}

function tickets(db: Db, viewer: Viewer, slug: string | null, key: string): Promise<string[]> {
  const match = /^([A-Za-z][A-Za-z0-9]*)-([1-9][0-9]{0,8})$/.exec(key.trim());
  if (!match) return Promise.resolve([]);
  const params: unknown[] = [match[1], Number(match[2])];
  return ids(
    db,
    `select tickets.id from tickets join projects on projects.id = tickets.project_id
     where lower(projects.key) = lower($1) and tickets.number = $2
       and ${workspaceCondition(viewer, "tickets.workspace_id", slug, params, "tickets.project_id")}`,
    params,
  );
}

/** The SQL condition, with its parameters, that a record is a Project's (by key) or the Workspace's own (null). */
function placeCondition(table: string, key: string | null, params: unknown[]): string {
  if (key === null) return `${table}.project_id is null`;
  params.push(key);
  return `${table}.project_id = (select id from projects where projects.workspace_id = ${table}.workspace_id
    and lower(projects.key) = lower($${params.length}))`;
}

function decisions(db: Db, viewer: Viewer, slug: string | null, key: string | null, number: string): Promise<string[]> {
  if (!/^[1-9][0-9]{0,8}$/.test(number)) return Promise.resolve([]);
  const params: unknown[] = [Number(number)];
  return ids(
    db,
    `select id from decisions where number = $1 and ${placeCondition("decisions", key, params)}
       and ${workspaceCondition(viewer, "decisions.workspace_id", slug, params, "decisions.project_id")}`,
    params,
  );
}

function terms(db: Db, viewer: Viewer, slug: string | null, key: string | null, name: string): Promise<string[]> {
  const params: unknown[] = [name];
  return ids(
    db,
    `select id from terms where lower(name) = lower($1) and ${placeCondition("terms", key, params)}
       and ${workspaceCondition(viewer, "terms.workspace_id", slug, params, "terms.project_id")}`,
    params,
  );
}

const tables = { document: "documents", artifact: "artifacts", transcript: "transcripts" } as const;
/** The column of a kind's Project, for kinds in a Project's Access; a Transcript's Access comes in a later change. */
const projectColumns = { document: "documents.project_id", artifact: "artifacts.project_id", transcript: undefined } as const;
const endingInId = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const endingInShortId = /(?:^|-)([0-9a-f]{8,32})$/i;

/** The ids starting with the hex digits given, as the bounds of a range of uuids. */
function idRange(start: string): [string, string] {
  const asId = (hex: string) => hex.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
  return [asId(start.padEnd(32, "0")), asId(start.padEnd(32, "f"))];
}

/**
 * A Document, Artifact or Transcript by its slug: the start of its id at the slug's end names it, unless another of
 * its kind anywhere in the installation shares that start.
 */
function bySlug(db: Db, viewer: Viewer, kind: keyof typeof tables, slug: string): Promise<string[]> {
  const table = tables[kind];
  const whole = endingInId.exec(slug)?.[1];
  if (whole) {
    const params: unknown[] = [whole];
    return ids(db, `select id from ${table} where id = $1 and ${workspaceCondition(viewer, `${table}.workspace_id`, null, params, projectColumns[kind])}`, params);
  }
  const short = endingInShortId.exec(slug)?.[1];
  if (!short) return Promise.resolve([]);
  const params: unknown[] = idRange(short.toLowerCase());
  return ids(
    db,
    `select id from ${table} where id between $1 and $2
       and (select count(*) from ${table} others where others.id between $1 and $2) = 1
       and ${workspaceCondition(viewer, `${table}.workspace_id`, null, params, projectColumns[kind])}`,
    params,
  );
}

/**
 * SQL for the slug of a Document, Artifact or Transcript, its readable form: the words of its title, then its short
 * id, the first 8 hex digits of its id, or its whole id while another of its kind anywhere in the installation starts
 * with the same 8.
 */
export function slugColumn(kind: keyof typeof tables, id: string, title: string): string {
  const table = tables[kind];
  const start = `left(${id}::text, 8)`;
  const shortId = `case when (select count(*) from ${table} others where others.id between
      (${start} || '-0000-0000-0000-000000000000')::uuid and (${start} || '-ffff-ffff-ffff-ffffffffffff')::uuid) = 1
    then ${start} else ${id}::text end`;
  return `concat_ws('-', nullif(slug_of(${title}), ''), ${shortId})`;
}

/** A slug in a response, which addresses are built from. */
export const slugDescription =
  "Its readable form, as its web address and the API take it in place of its id: the words of its title, then its " +
  "short id. The words are only for reading; the short id finds it.";
