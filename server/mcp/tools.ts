import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Guidance } from "../http/errors.js";
import { isUuid } from "../http/ids.js";

/**
 * Cronk's MCP tools for an Agent. They hold no rules of their own: each calls the HTTP
 * API as the Agent, through `Api`, and passes on whatever the API answers, refusals included.
 */

/**
 * A request to Cronk's HTTP API, made as the Agent: with a JSON body, or with a file's bytes as the body, sent with
 * its media type.
 */
export type Api = (
  method: string,
  path: string,
  body?: unknown,
  file?: { bytes: Buffer; mediaType: string },
) => Promise<{ status: number; json: unknown }>;

interface Refusal extends Partial<Guidance> {
  code: string;
  message: string;
}

/** A refusal for the tool's caller, as the API words it. */
class Refused extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.message);
  }
}

interface Workspace {
  id: string;
  name: string;
}
interface ProjectSummary {
  id: string;
  key: string;
  name: string;
}
interface Project extends ProjectSummary {
  statuses: { id: string; name: string; kind: string }[];
}
interface TicketSummary {
  id: string;
  projectId: string;
  key: string;
  title: string;
  statusId: string;
  priority: string;
  labels: string[];
  assigneeId: string | null;
  dueDate: string | null;
  estimate: number | null;
}

const ticketArgument = z.string().min(1).describe("The Ticket's key, such as `CRONK-12`, or its id.");

const rights =
  "Agents may read their Workspace, comment on its Tickets, file Tickets, create, save and move Documents, " +
  "attaching files to Documents and to their own Comments, create and save Terms (only Users delete Documents " +
  "and Terms), create and save Artifacts (only Users delete them), and propose Decisions and edit their text (only Users change a Decision's status). During your " +
  "running Run on a Ticket you may also edit its description, Priority, Labels, due date and estimate, attach files to it, split it into Sub-Tickets, write Reports on it, link Documents and Artifacts to it and unlink " +
  "them, and finish the Run (a Merge Step's Run may instead merge its Ticket's Pull Request with `merge_pull_request`). A Ticket you file outside your Ticket's Sub-Tickets is a Discovered Ticket, waiting for " +
  "its Assignee: until a User delegates, moves or dismisses it you may edit it, title included, add blocks from " +
  "it, or make it blocked by any Ticket of the Workspace, delegated or running included, link Documents and Artifacts to it and unlink them, such as the spec Document you filed it from, and split " +
  "it into Sub-Tickets, which are Discovered Tickets of yours too and are settled along with it, so a planned piece " +
  "of work is filed as one parent Ticket with its slices under it. Anything else is refused with the rule and what to do instead.";

export function buildMcpServer(api: Api): McpServer {
  const server = new McpServer(
    { name: "Cronk", version: "0.0.0" },
    {
      instructions:
        "Cronk tracks Tickets for Users and their Agents, and keeps written knowledge as Documents in the page tree of " +
        "each Project and of the Workspace, as Terms in their glossaries (a Project's glossary is its Terms over the " +
        "Workspace's), recorded choices as numbered Decisions of each Project and of the Workspace, and live pages such " +
        "as HTML prototypes as Artifacts, shown sandboxed; " +
        "`export_knowledge` gives both as `GLOSSARY.md` and `docs/adr/` files to commit into your branch. You act as " +
        `one Agent. ${rights}`,
    },
  );

  async function get<T>(path: string): Promise<T> {
    return send<T>("GET", path);
  }

  async function send<T>(method: string, path: string, body?: unknown, file?: { bytes: Buffer; mediaType: string }): Promise<T> {
    const { status, json } = await api(method, path, body, file);
    if (status >= 400) throw new Refused((json as { error: Refusal }).error);
    return json as T;
  }

  let workspace: Promise<Workspace> | undefined;
  const ownWorkspace = () => (workspace ??= get<{ workspace: Workspace }>("/api/agent").then((me) => me.workspace));

  async function ticketByKeyOrId(ticket: string) {
    if (isUuid(ticket)) return get<{ id: string; key: string; projectId: string }>(`/api/tickets/${ticket}`);
    const { id } = await ownWorkspace();
    return get<{ id: string; key: string; projectId: string }>(`/api/workspaces/${id}/tickets/${encodeURIComponent(ticket)}`);
  }

  async function projects() {
    const { id } = await ownWorkspace();
    return get<ProjectSummary[]>(`/api/workspaces/${id}/projects`);
  }

  /** The Project of your Workspace with that key, ignoring case; refused naming the keys there are. */
  async function projectByKey(key: string, orElse = "") {
    const all = await projects();
    const project = all.find((p) => p.key.toLowerCase() === key.trim().toLowerCase());
    if (project) return project;
    throw new Refused({
      code: "unknown_project",
      message: `Your Workspace has no Project with the key ${key}.`,
      rule: "A Project is named by its key, among the Projects of your Workspace.",
      advice: `Use one of these keys${orElse}: ${all.map((p) => p.key).join(", ") || "(none yet)"}.`,
    });
  }

  server.registerTool(
    "read_ticket",
    {
      title: "Read a Ticket",
      description:
        "A Ticket of your Workspace with its fields, the Ticket keys its description mentions and, as `mentionedIn`, " +
        "the texts mentioning it (other Tickets, Comments, Documents, Reports, Terms and Decisions you can read); " +
        "its Comments (oldest first), with those on its Linked Artifacts, each naming its `artifact`; its Relations: " +
        "the Tickets it blocks, is blocked by and relates to, its parent and its Sub-Tickets; its Runs, oldest first; " +
        "the Reports its Runs wrote, oldest first, which a Run on the Ticket builds on; its Pull Requests, linked by key or by a User by hand (`manual`), each with its " +
        "state (open, draft, merged or closed), the checks on its latest commit, its review state (approved or " +
        "changes requested, and by whom), the Step that produced it and the failing check, review requesting changes or merge conflict that last sent the Ticket back to that Step, which Cronk's Comment also links; " +
        "its Linked Documents, " +
        "Documents of its Project or the Workspace that the work needs, which you read with `read_document`; its " +
        "Linked Artifacts, which you read with `read_artifact`; and the " +
        "files attached to it, each Comment carrying its own. Markdown refers to an Attachment as `attachment:<id>`. " +
        "A Ticket outside your Workspace answers as not found.",
      inputSchema: { ticket: ticketArgument },
      annotations: { readOnlyHint: true },
    },
    ({ ticket }) =>
      answer(async () => {
        const found = await ticketByKeyOrId(ticket);
        return {
          ticket: found,
          comments: await get(`/api/tickets/${found.id}/comments`),
          relations: await get(`/api/tickets/${found.id}/relations`),
          runs: await get(`/api/tickets/${found.id}/runs`),
          reports: await get(`/api/tickets/${found.id}/reports`),
          pullRequests: await get(`/api/tickets/${found.id}/pull-requests`),
          linkedDocuments: await get(`/api/tickets/${found.id}/documents`),
          linkedArtifacts: await get(`/api/tickets/${found.id}/artifacts`),
          attachments: await get(`/api/tickets/${found.id}/attachments`),
        };
      }),
  );

  server.registerTool(
    "search",
    {
      title: "Search",
      description:
        "Finds Tickets, Documents, Reports, Terms, Decisions, Artifacts (by title and description) and Transcripts of " +
        "your Workspace that you can read, best first with Transcripts last, each with its kind, id, title, Project, " +
        "Ticket key (a Ticket's own, or the Ticket a Report is on or a Transcript's Run was on) and a snippet whose " +
        "matching words are marked. Words match by their stem in English (`merging` finds `merged`); write `\"a phrase\"` for words " +
        "in order, `or` between alternatives and `-word` to leave out what has it. Search before filing a Ticket or " +
        "writing knowledge, to build on what's there; read a result with its own tool (Transcripts have none yet).",
      inputSchema: {
        query: z.string().min(1).max(1000),
        project: z
          .string()
          .optional()
          .describe(
            "A Project's key, such as `CRONK`: only its own Tickets and knowledge and the Transcripts of Runs on its " +
              "Tickets. The whole Workspace when left out.",
          ),
        kinds: z
          .array(z.enum(["ticket", "document", "report", "term", "decision", "artifact", "transcript"]))
          .min(1)
          .optional()
          .describe("Only these kinds. All when left out."),
      },
      annotations: { readOnlyHint: true },
    },
    ({ query, project, kinds }) =>
      answer(async () => {
        const { id } = await ownWorkspace();
        const params = new URLSearchParams({ q: query });
        if (project) params.set("project", (await projectByKey(project, ", or leave the Project out")).id);
        if (kinds) params.set("kinds", kinds.join(","));
        return get(`/api/workspaces/${id}/search?${params}`);
      }),
  );

  server.registerTool(
    "list_tickets",
    {
      title: "List Tickets",
      description:
        "Tickets of your Workspace, by Project in board order, narrowed by whichever filters are given. " +
        "Read one with `read_ticket` for its description and Comments.",
      inputSchema: {
        project: z.string().optional().describe("A Project's key, such as `CRONK`. All Projects when left out."),
        status: z.string().optional().describe("A Status's name, such as `Backlog`, ignoring case."),
        priority: z.enum(["urgent", "high", "medium", "low", "none"]).optional(),
        label: z.string().optional().describe("A Label, ignoring case."),
      },
      annotations: { readOnlyHint: true },
    },
    (filter) =>
      answer(async () => {
        const chosen = filter.project ? [await projectByKey(filter.project, ", or leave the Project out")] : await projects();
        const tickets = [];
        for (const summary of chosen) {
          const project = await get<Project>(`/api/projects/${summary.id}`);
          const status = filter.status
            ? project.statuses.find((s) => s.name.toLowerCase() === filter.status!.trim().toLowerCase())
            : undefined;
          if (filter.status && !status) {
            if (filter.project) {
              throw new Refused({
                code: "unknown_status",
                message: `${project.key} has no Status named ${filter.status}.`,
                rule: "A Status is named as it is on its Project's board, ignoring case.",
                advice: `Use one of its Statuses: ${project.statuses.map((s) => s.name).join(", ")}.`,
              });
            }
            continue;
          }
          const query = new URLSearchParams();
          if (status) query.set("statusId", status.id);
          if (filter.priority) query.set("priority", filter.priority);
          if (filter.label) query.set("label", filter.label);
          const found = await get<TicketSummary[]>(`/api/projects/${project.id}/tickets?${query}`);
          const statusName = new Map(project.statuses.map((s) => [s.id, s.name]));
          tickets.push(
            ...found.map(({ id, key, title, statusId, priority, labels, assigneeId, dueDate, estimate }) => ({
              id,
              key,
              title,
              status: statusName.get(statusId),
              priority,
              labels,
              assigneeId,
              dueDate,
              estimate,
            })),
          );
        }
        return tickets;
      }),
  );

  server.registerTool(
    "comment",
    {
      title: "Comment on a Ticket or an Artifact",
      description:
        "Adds a Markdown Comment to a Ticket or an Artifact of your Workspace, as your Agent, or a reply to one of " +
        "its Comments: give exactly one of `ticket` and `artifact`. A Comment on an Artifact also shows on the " +
        "Tickets linking it. Refused for a read-only token; a Ticket or Artifact outside your Workspace answers as " +
        "not found, and a reply only goes to a Comment on the same Ticket or Artifact: reply to a Comment on a " +
        "Linked Artifact, as `read_ticket` shows it, by its `artifactId`.",
      inputSchema: {
        ticket: ticketArgument.optional(),
        artifact: z
          .string()
          .min(1)
          .optional()
          .describe("The Artifact's slug, such as `board-prototype-3f9a1b2c` (its words may be stale), or its id."),
        body: z.string().min(1).describe("Markdown."),
        replyToId: z.string().optional().describe("The id of the Comment on this Ticket or Artifact being replied to."),
      },
    },
    ({ ticket, artifact, body, replyToId }) =>
      answer(async () => {
        if ((ticket === undefined) === (artifact === undefined)) {
          throw new Refused({
            code: "one_target",
            message: "A Comment is on exactly one Ticket or Artifact.",
            rule: "Each Comment belongs to one Ticket or one Artifact.",
            advice: "Give exactly one of `ticket` and `artifact`; comment again for another.",
          });
        }
        if (artifact !== undefined) {
          return send("POST", `/api/artifacts/${encodeURIComponent(artifact)}/comments`, { body, replyToId });
        }
        const found = await ticketByKeyOrId(ticket!);
        return send("POST", `/api/tickets/${found.id}/comments`, { body, replyToId });
      }),
  );

  server.registerTool(
    "edit_ticket",
    {
      title: "Edit your Run's Ticket",
      description:
        "During your running Run on a Ticket, changes whichever of its description, Priority, Labels, due date and " +
        "estimate are given; `null` clears a due date or estimate, and Labels replace the Ticket's Labels. Each Change " +
        "records your Run. A Discovered Ticket you filed you may also edit outside a Run, its title included, until a " +
        "User delegates, moves or dismisses it. Refused for any other Ticket, outside a running Run, and for any other " +
        "field: a Ticket's Assignee, Delegation, parent and Status are for Users, and a Run moves its Ticket with `finish`.",
      inputSchema: {
        ticket: ticketArgument,
        title: z.string().min(1).optional().describe("A new title; only for a Discovered Ticket you filed."),
        description: z.string().optional().describe("The whole new description, in Markdown."),
        priority: z.enum(["urgent", "high", "medium", "low", "none"]).optional(),
        labels: z.array(z.string().min(1)).optional().describe("The Ticket's Labels, all of them."),
        dueDate: z.string().nullable().optional().describe("A date such as `2026-02-01`, or null to clear it."),
        estimate: z.number().min(0).nullable().optional().describe("A number, or null to clear it."),
      },
    },
    ({ ticket, ...edit }) =>
      answer(async () => {
        const found = await ticketByKeyOrId(ticket);
        return send("PATCH", `/api/tickets/${found.id}`, edit);
      }),
  );

  server.registerTool(
    "create_sub_ticket",
    {
      title: "Split a Ticket into a Sub-Ticket",
      description:
        "During your running Run on a Ticket, creates a Sub-Ticket of it in the same Project's first Backlog Status, " +
        "with its Assignee and Delegation. The Ticket gets no Runs while a Sub-Ticket is unfinished. Outside a Run, " +
        "splits a Discovered Ticket you filed that still waits for a User, to file a planned piece of work as one " +
        "parent with its slices under it: each Sub-Ticket is a Discovered Ticket of yours with the same source, which " +
        "you may edit and add blocks from (between slices, say), but only the parent waits in the Inbox. When a User " +
        "delegates, moves or dismisses the parent, its Sub-Tickets are settled with it; delegating it hands them the " +
        "Delegation. Refused for any other parent, such as a Ticket you didn't file or one a User has taken up.",
      inputSchema: {
        ticket: ticketArgument.describe(
          "The parent: your Run's Ticket, or a waiting Discovered Ticket you filed. Its key, such as `CRONK-12`, or its id.",
        ),
        title: z.string().min(1),
        description: z.string().optional().describe("Markdown."),
      },
    },
    ({ ticket, title, description }) =>
      answer(async () => {
        const parent = await ticketByKeyOrId(ticket);
        return send("POST", `/api/projects/${parent.projectId}/tickets`, { title, description, parentId: parent.id });
      }),
  );

  server.registerTool(
    "file_ticket",
    {
      title: "File a Discovered Ticket",
      description:
        "Files a Ticket you found that isn't part of your Ticket's work, such as a bug noticed on the way, as a " +
        "Discovered Ticket: in the Project's first Backlog Status, undelegated, assigned to the Assignee of your Run's " +
        "Ticket (or, without a Run, to your Owner) and waiting in their Inbox. Until a User delegates, moves or " +
        "dismisses it you may edit it with `edit_ticket`, add blocks from it, or to it from any Ticket, with `add_block` and split it into " +
        "Sub-Tickets with `create_sub_ticket`. To split your own Run's Ticket's work, use `create_sub_ticket` instead.",
      inputSchema: {
        project: z.string().min(1).describe("A Project's key, such as `CRONK`."),
        title: z.string().min(1),
        description: z.string().optional().describe("Markdown."),
        run: z.string().min(1).optional().describe("Your running Run's id, as your Brief gives it, recorded as the source."),
      },
    },
    ({ project, title, description, run }) =>
      answer(async () => {
        const { id } = await projectByKey(project);
        return send("POST", `/api/projects/${id}/tickets`, { title, description, runId: run });
      }),
  );

  server.registerTool(
    "add_block",
    {
      title: "Block a Ticket by your Discovered Ticket, or make yours wait on one",
      description:
        "Adds a block between a waiting Discovered Ticket you filed and another Ticket of your Workspace, either " +
        "way round: give `blocks` for a Ticket yours blocks, which then gets no Runs until yours is finished, or " +
        "`blockedBy` for a Ticket yours waits on, which may be delegated, running or in another Project. Give " +
        "exactly one of them. Refused unless `ticket` is a Discovered Ticket you filed that still waits for a User " +
        "(or the `blockedBy` Ticket is), and for a block that would form a cycle.",
      inputSchema: {
        ticket: ticketArgument.describe("Your Discovered Ticket: its key, such as `CRONK-12`, or its id."),
        blocks: ticketArgument.optional().describe("The Ticket it blocks: its key, such as `CRONK-12`, or its id."),
        blockedBy: ticketArgument
          .optional()
          .describe("The Ticket it waits on, blocked by it: its key, such as `CRONK-12`, or its id."),
      },
    },
    ({ ticket, blocks, blockedBy }) =>
      answer(async () => {
        if ((blocks === undefined) === (blockedBy === undefined)) {
          throw new Refused({
            code: "one_side_of_block",
            message: "Give exactly one of `blocks` and `blockedBy`.",
            rule: "A block names the Ticket yours blocks, or the Ticket yours is blocked by: one at a time.",
            advice: "Call `add_block` once for each block.",
          });
        }
        const found = await ticketByKeyOrId(ticket);
        const named = (blocks ?? blockedBy)!;
        const other = isUuid(named) ? { ticketId: named } : { ticketKey: named };
        return send("POST", `/api/tickets/${found.id}/relations`, { kind: blocks ? "blocks" : "blockedBy", ...other });
      }),
  );

  server.registerTool(
    "write_report",
    {
      title: "Write a Report on your Run's Ticket",
      description:
        "During your running Run on a Ticket, adds a Report to it: Markdown such as an investigation's findings, " +
        "listed with the Ticket for its Users and read by later Runs on it. Refused for any other Ticket and outside " +
        "a running Run. A Report can also be given to `finish`. A Report is a Document with Versions: " +
        "`read_document` and `edit_document` take its id.",
      inputSchema: {
        ticket: ticketArgument,
        title: z.string().min(1).describe("A short title, such as `Findings`."),
        body: z.string().min(1).describe("Markdown."),
      },
    },
    ({ ticket, title, body }) =>
      answer(async () => {
        const found = await ticketByKeyOrId(ticket);
        return send("POST", `/api/tickets/${found.id}/reports`, { title, body });
      }),
  );

  const documentArgument = z
    .string()
    .min(1)
    .describe("The Document's slug, such as `onboarding-3f9a1b2c` (its words may be stale), or its id.");

  /**
   * The path of a Project's knowledge, by the Project's key, or of the Workspace's when none is given; the
   * Workspace's may be reached by another name than the Project's.
   */
  async function placePath(project: string | undefined, knowledge: string, workspaceKnowledge = knowledge) {
    if (project) {
      return `/api/projects/${(await projectByKey(project, ", or leave the Project out for the Workspace's")).id}/${knowledge}`;
    }
    return `/api/workspaces/${(await ownWorkspace()).id}/${workspaceKnowledge}`;
  }

  const documentPath = (document: string) => `/api/documents/${encodeURIComponent(document)}`;

  server.registerTool(
    "list_documents",
    {
      title: "List a page tree's Documents",
      description:
        "The Documents of a Project's page tree, or of the Workspace's when no Project is given, without their bodies, " +
        "in tree order: each right after its parent (`parentId`), siblings by their place (`position`). A Project's " +
        "page tree and the Workspace's are separate. Read one with `read_document`.",
      inputSchema: {
        project: z.string().optional().describe("A Project's key, such as `CRONK`. The Workspace's page tree when left out."),
      },
      annotations: { readOnlyHint: true },
    },
    ({ project }) => answer(async () => get(await placePath(project, "documents"))),
  );

  server.registerTool(
    "read_document",
    {
      title: "Read a Document",
      description:
        "A Document of your Workspace as Markdown, at its current Version, whose number a save names as its " +
        "`baseVersion`; or, given a Version's number, that earlier Version.",
      inputSchema: {
        document: documentArgument,
        version: z.number().int().min(1).optional().describe("An earlier Version's number. The current one when left out."),
      },
      annotations: { readOnlyHint: true },
    },
    ({ document, version }) =>
      answer(() => get(version === undefined ? documentPath(document) : `${documentPath(document)}/versions/${version}`)),
  );

  server.registerTool(
    "list_document_versions",
    {
      title: "List a Document's Versions",
      description: "Each Version of a Document, oldest first: its number, title, the Actor who saved it and when.",
      inputSchema: { document: documentArgument },
      annotations: { readOnlyHint: true },
    },
    ({ document }) => answer(() => get(`${documentPath(document)}/versions`)),
  );

  server.registerTool(
    "compare_versions",
    {
      title: "Compare two Versions of a Document",
      description: "Both Versions, and their bodies compared line by line: each line `same`, `removed` or `added`.",
      inputSchema: {
        document: documentArgument,
        from: z.number().int().min(1).describe("The earlier Version's number."),
        to: z.number().int().min(1).describe("The later Version's number."),
      },
      annotations: { readOnlyHint: true },
    },
    ({ document, from, to }) => answer(() => get(`${documentPath(document)}/versions/compare?from=${from}&to=${to}`)),
  );

  server.registerTool(
    "create_document",
    {
      title: "Create a Document",
      description:
        "Creates a Markdown Document in a Project's page tree, or the Workspace's when no Project is given, at Version " +
        "1 by your Agent: under a parent of the same page tree or at its top, last among its siblings unless placed.",
      inputSchema: {
        project: z.string().optional().describe("A Project's key, such as `CRONK`. The Workspace's page tree when left out."),
        title: z.string().min(1),
        body: z.string().optional().describe("Markdown."),
        parent: z.string().optional().describe("The slug or id of a Document of the same page tree to sit under."),
        position: z.number().int().min(0).optional().describe("A place among its siblings, counting from 0."),
      },
    },
    ({ project, parent, ...input }) =>
      answer(async () => send("POST", await placePath(project, "documents"), { ...input, parentId: parent })),
  );

  server.registerTool(
    "edit_document",
    {
      title: "Save, rename or move a Document",
      description:
        "A new title or body saves a Document as its next Version, by your Agent, based on the Version you read: give " +
        "its number as `baseVersion`. A save based on an outdated Version is refused with `outdated_version`, carrying " +
        "the current Version as `current`: merge your change into it and save again based on it. A new parent or place " +
        "moves the Document within its page tree, making no Version. Only Users delete Documents.",
      inputSchema: {
        document: documentArgument,
        baseVersion: z.number().int().min(1).optional().describe("The number of the Version your save is based on."),
        title: z.string().min(1).optional(),
        body: z.string().optional().describe("The whole new body, in Markdown."),
        parent: z
          .string()
          .nullable()
          .optional()
          .describe("The slug or id of a Document of the same page tree to sit under, or null for the top."),
        position: z.number().int().min(0).optional().describe("A place among its siblings, counting from 0."),
      },
    },
    ({ document, parent, ...edit }) => answer(() => send("PATCH", documentPath(document), { ...edit, parentId: parent })),
  );

  const sectionArgument = z
    .string()
    .min(1)
    .describe("Its heading's text, or a path joining headings with `/`, such as `Install/Linux`, where two headings read alike.");
  const sectionRules =
    "A Section is a heading of any level with everything up to the next heading of the same or a higher level, its " +
    "subsections included. A name matching several Sections is refused with `section_ambiguous`, naming them as " +
    "paths in `candidates`; one matching none with `section_not_found`, listing the Document's headings in `headings`.";

  server.registerTool(
    "read_section",
    {
      title: "Read one Section of a Document",
      description:
        "One Section of a Document as Markdown, its heading included, at the Document's current Version, whose number " +
        `a replace names as its \`baseVersion\`: a long Document needn't be read in full. ${sectionRules}`,
      inputSchema: { document: documentArgument, section: sectionArgument },
      annotations: { readOnlyHint: true },
    },
    ({ document, section }) =>
      answer(() => get(`${documentPath(document)}/sections?section=${encodeURIComponent(section)}`)),
  );

  server.registerTool(
    "replace_section",
    {
      title: "Replace one Section of a Document",
      description:
        "Replaces one Section of a Document with `body`, saving the Document as its next Version by your Agent; the " +
        "rest stays as it was. The new body starts with a heading of the Section's own level, whose text may change, " +
        "and holds no other heading of that level or a higher one (`section_heading_level`). Give the number of the " +
        "Version you read as `baseVersion`: a replace based on an outdated Version is refused with `outdated_version`, " +
        `carrying the current Version as \`current\`. ${sectionRules}`,
      inputSchema: {
        document: documentArgument,
        section: sectionArgument,
        baseVersion: z.number().int().min(1).describe("The number of the Version your replace is based on."),
        body: z.string().describe("The Section's new Markdown: its heading, of the same level, and everything under it."),
      },
    },
    ({ document, ...replace }) => answer(() => send("PUT", `${documentPath(document)}/sections`, replace)),
  );

  const termArgument = z
    .string()
    .min(1)
    .describe("The Term's name, ignoring case, after its Project's key for a Project's (`CRONK/Ticket`); or its id.");
  const termPath = (term: string) => `/api/terms/${encodeURIComponent(term)}`;
  const avoidArgument = z.array(z.string().min(1)).describe("Words to avoid in the Term's place.");

  server.registerTool(
    "read_glossary",
    {
      title: "Read a glossary",
      description:
        "A Project's glossary: its Terms over the Workspace's, a Project Term replacing a Workspace Term of the same " +
        "name ignoring case; or, when no Project is given, the Workspace's Terms. Each Term has its name, definition, " +
        "the words to avoid, its current Version and `projectId`, null for the Workspace's. Use its names, and avoid " +
        "the words it lists, in what you write.",
      inputSchema: {
        project: z.string().optional().describe("A Project's key, such as `CRONK`. The Workspace's Terms when left out."),
      },
      annotations: { readOnlyHint: true },
    },
    ({ project }) =>
      // A Project's glossary layers its Terms over the Workspace's; the Workspace's is its own Terms.
      answer(async () => get(await placePath(project, "glossary", "terms"))),
  );

  server.registerTool(
    "read_term",
    {
      title: "Read a Term",
      description:
        "A Term at its current Version, whose number a save names as its `baseVersion`; or, given a Version's " +
        "number, what that earlier Version said.",
      inputSchema: {
        term: termArgument,
        version: z.number().int().min(1).optional().describe("An earlier Version's number. The current one when left out."),
      },
      annotations: { readOnlyHint: true },
    },
    ({ term, version }) => answer(() => get(version === undefined ? termPath(term) : `${termPath(term)}/versions/${version}`)),
  );

  server.registerTool(
    "list_term_versions",
    {
      title: "List a Term's Versions",
      description: "Each Version of a Term, oldest first: what it said, the Actor who saved it and when.",
      inputSchema: { term: termArgument },
      annotations: { readOnlyHint: true },
    },
    ({ term }) => answer(() => get(`${termPath(term)}/versions`)),
  );

  server.registerTool(
    "compare_term_versions",
    {
      title: "Compare two Versions of a Term",
      description:
        "Both Versions with their names, their definitions compared line by line and their words to avoid one by one: " +
        "each line `same`, `removed` or `added`.",
      inputSchema: {
        term: termArgument,
        from: z.number().int().min(1).describe("The earlier Version's number."),
        to: z.number().int().min(1).describe("The later Version's number."),
      },
      annotations: { readOnlyHint: true },
    },
    ({ term, from, to }) => answer(() => get(`${termPath(term)}/versions/compare?from=${from}&to=${to}`)),
  );

  server.registerTool(
    "create_term",
    {
      title: "Create a Term",
      description:
        "Creates a Term in a Project, or in the Workspace when no Project is given, at Version 1 by your Agent. Its " +
        "name is unique ignoring case among the Project's own Terms, or the Workspace's: a taken one is refused with " +
        "`term_name_taken`. A Project Term replaces a Workspace Term of the same name in the Project's glossary.",
      inputSchema: {
        project: z.string().optional().describe("A Project's key, such as `CRONK`. The Workspace's when left out."),
        name: z.string().min(1),
        definition: z.string().optional().describe("Markdown."),
        avoid: avoidArgument.optional(),
      },
    },
    ({ project, ...input }) =>
      answer(async () => send("POST", await placePath(project, "terms"), input)),
  );

  server.registerTool(
    "edit_term",
    {
      title: "Save a Term",
      description:
        "Saves a Term as its next Version, by your Agent, keeping what you leave out, based on the Version you read: " +
        "give its number as `baseVersion`. A save based on an outdated Version is refused with `outdated_version`, " +
        "carrying the current Version as `current`: merge your change into it and save again based on it. Only Users " +
        "delete Terms.",
      inputSchema: {
        term: termArgument,
        baseVersion: z.number().int().min(1).describe("The number of the Version your save is based on."),
        name: z.string().min(1).optional(),
        definition: z.string().optional().describe("The whole new definition, in Markdown."),
        avoid: avoidArgument.optional().describe("The whole new list of words to avoid."),
      },
    },
    ({ term, ...edit }) => answer(() => send("PATCH", termPath(term), edit)),
  );

  server.registerTool(
    "link_document",
    {
      title: "Link a Document to a Ticket",
      description:
        "During your running Run on a Ticket, or on a Discovered Ticket you filed until a User delegates, moves or " +
        "dismisses it, links a Document of the Ticket's Project or of the Workspace to it, so it is one click away " +
        "for its Users and later Runs read it with the Ticket: link the spec a Discovered Ticket comes from rather " +
        "than only naming it. Refused for a Document of another Project and for any other Ticket.",
      inputSchema: { ticket: ticketArgument, document: documentArgument },
    },
    ({ ticket, document }) =>
      answer(async () => {
        const found = await ticketByKeyOrId(ticket);
        return send("POST", `/api/tickets/${found.id}/documents`, { documentId: document });
      }),
  );

  server.registerTool(
    "unlink_document",
    {
      title: "Unlink a Document from a Ticket",
      description:
        "During your running Run on a Ticket, or on a Discovered Ticket you filed until a User delegates, moves or " +
        "dismisses it, unlinks one of its Linked Documents; the Document stays in its page tree. Answers with the " +
        "Ticket's Linked Documents left. Refused for any other Ticket.",
      inputSchema: { ticket: ticketArgument, document: documentArgument },
    },
    ({ ticket, document }) =>
      answer(async () => {
        const found = await ticketByKeyOrId(ticket);
        await send("DELETE", `/api/tickets/${found.id}/documents/${encodeURIComponent(document)}`);
        return get(`/api/tickets/${found.id}/documents`);
      }),
  );

  server.registerTool(
    "attach_file",
    {
      title: "Attach a file",
      description:
        "Attaches a file, such as a screenshot or a log, given as base64, to exactly one of: a Ticket during your " +
        "running Run on it (or a Discovered Ticket you filed that waits for a User), a Document, or a Comment you " +
        "wrote. Each file is at most the size Cronk is configured with (25 MB by default). Markdown refers to the " +
        "Attachment as `attachment:<id>`, such as `![Screenshot](attachment:<id>)` in a Document or Comment.",
      inputSchema: {
        ticket: ticketArgument.optional(),
        document: z.string().min(1).optional().describe("A Document's slug or id."),
        comment: z.string().min(1).optional().describe("The id of a Comment you wrote."),
        name: z.string().min(1).describe("The file's name, such as `screenshot.png`."),
        mediaType: z.string().optional().describe("Its media type, such as `image/png`; `application/octet-stream` when left out."),
        contentBase64: z.string().describe("The file's bytes, in base64."),
      },
    },
    ({ ticket, document, comment, name, mediaType, contentBase64 }) =>
      answer(async () => {
        const targets = [ticket, document, comment].filter((target) => target !== undefined);
        if (targets.length !== 1) {
          throw new Refused({
            code: "one_target",
            message: "A file is attached to exactly one Ticket, Document or Comment.",
            rule: "Each Attachment belongs to one Ticket, Document or Comment.",
            advice: "Give exactly one of `ticket`, `document` and `comment`; attach the file again for another.",
          });
        }
        const content = contentBase64.replace(/\s/g, "");
        if (content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) {
          throw new Refused({
            code: "invalid_base64",
            message: "`contentBase64` isn't base64.",
            rule: "A file's bytes are given in standard base64, padded with `=`.",
            advice: "Encode the file's bytes as base64, for example with `base64 -w0 <file>`, and attach it again.",
          });
        }
        const path = ticket
          ? `/api/tickets/${(await ticketByKeyOrId(ticket)).id}`
          : document
            ? documentPath(document)
            : `/api/comments/${encodeURIComponent(comment!)}`;
        const file = { bytes: Buffer.from(content, "base64"), mediaType: mediaType?.trim() || "application/octet-stream" };
        return send("POST", `${path}/attachments?name=${encodeURIComponent(name)}`, undefined, file);
      }),
  );

  const artifactArgument = z
    .string()
    .min(1)
    .describe("The Artifact's slug, such as `board-prototype-3f9a1b2c` (its words may be stale), or its id.");
  const artifactPath = (artifact: string) => `/api/artifacts/${encodeURIComponent(artifact)}`;
  const artifactPathArgument = z.string().min(1).describe("A path relative to the Version, such as `index.html` or `scripts/app.js`.");
  const artifactFiles = z.array(
    z.object({
      path: artifactPathArgument,
      contentBase64: z.string().describe("The file's bytes, in base64."),
      mediaType: z.string().optional().describe("Its media type; from its extension when left out, such as `text/html` for `.html`."),
    }),
  );
  const sizeLimit =
    "A Version's files are at most the Attachments size limit Cronk is configured with (25 MB by default) in all; " +
    "load libraries from a CDN rather than adding them.";

  server.registerTool(
    "list_artifacts",
    {
      title: "List Artifacts",
      description:
        "A Project's Artifacts, or the Workspace's when no Project is given, last changed first, without their files. " +
        "Read one with `read_artifact`.",
      inputSchema: {
        project: z.string().optional().describe("A Project's key, such as `CRONK`. The Workspace's when left out."),
      },
      annotations: { readOnlyHint: true },
    },
    ({ project }) => answer(async () => get(await placePath(project, "artifacts"))),
  );

  server.registerTool(
    "read_artifact",
    {
      title: "Read an Artifact",
      description:
        "An Artifact of your Workspace at its current Version, whose number a save names as its `baseVersion`: its " +
        "title, description, page, files (path, media type and size), the address its page is served at and its " +
        "Comments, oldest first; or, given a path, that file with its bytes as base64.",
      inputSchema: {
        artifact: artifactArgument,
        path: artifactPathArgument.optional(),
      },
      annotations: { readOnlyHint: true },
    },
    ({ artifact, path }) =>
      answer(async () => {
        if (path !== undefined) return get(`${artifactPath(artifact)}/file?path=${encodeURIComponent(path)}`);
        const found = (await get(artifactPath(artifact))) as { id: string };
        return { ...found, comments: await get(`/api/artifacts/${found.id}/comments`) };
      }),
  );

  server.registerTool(
    "create_artifact",
    {
      title: "Create an Artifact",
      description:
        "Creates an Artifact, a live page such as an HTML prototype, in a Project or the Workspace when no Project is " +
        "given, at Version 1 by your Agent: its page and the files it refers to by relative paths (scripts, styles, " +
        "images, data), each with its bytes as base64. It is served sandboxed: its scripts run, and may load from " +
        "CDNs, but can't call Cronk's API, and `attachment:` references don't work in it. Name your running Run to " +
        "link it to the Run's Ticket, where its Users find it; it is then kept in that Ticket's Project or the " +
        "Workspace. " +
        sizeLimit,
      inputSchema: {
        project: z.string().optional().describe("A Project's key, such as `CRONK`. The Workspace's when left out."),
        title: z.string().min(1),
        description: z.string().optional().describe("What it shows, in a sentence or two."),
        page: artifactPathArgument.optional().describe("The path of the file that is its page; `index.html` when left out."),
        files: artifactFiles,
        run: z.string().min(1).optional().describe("Your running Run's id, as your Brief gives it: links the Artifact to its Ticket."),
      },
    },
    ({ project, run, ...input }) =>
      answer(async () => send("POST", await placePath(project, "artifacts"), { ...input, runId: run })),
  );

  server.registerTool(
    "link_artifact",
    {
      title: "Link an Artifact to a Ticket",
      description:
        "During your running Run on a Ticket, or on a Discovered Ticket you filed until a User delegates, moves or " +
        "dismisses it, links an Artifact of the Ticket's Project or of the Workspace to it, so it is one click away " +
        "for its Users. Refused for an Artifact of another Project and for any other Ticket.",
      inputSchema: { ticket: ticketArgument, artifact: artifactArgument },
    },
    ({ ticket, artifact }) =>
      answer(async () => {
        const found = await ticketByKeyOrId(ticket);
        return send("POST", `/api/tickets/${found.id}/artifacts`, { artifactId: artifact });
      }),
  );

  server.registerTool(
    "unlink_artifact",
    {
      title: "Unlink an Artifact from a Ticket",
      description:
        "During your running Run on a Ticket, or on a Discovered Ticket you filed until a User delegates, moves or " +
        "dismisses it, unlinks one of its Linked Artifacts; the Artifact stays where it is kept. Answers with the " +
        "Ticket's Linked Artifacts left. Refused for any other Ticket.",
      inputSchema: { ticket: ticketArgument, artifact: artifactArgument },
    },
    ({ ticket, artifact }) =>
      answer(async () => {
        const found = await ticketByKeyOrId(ticket);
        await send("DELETE", `/api/tickets/${found.id}/artifacts/${encodeURIComponent(artifact)}`);
        return get(`/api/tickets/${found.id}/artifacts`);
      }),
  );

  server.registerTool(
    "save_artifact",
    {
      title: "Save an Artifact",
      description:
        "Saves an Artifact as its next Version by your Agent, holding the whole set of files: the current Version's, " +
        "with `files` added or replacing those at the same paths and those in `remove` taken out; a new title, " +
        "description or page may come with it. Name the Version it's based on as `baseVersion`; a save based on an " +
        "outdated Version is refused with the current one. " +
        sizeLimit,
      inputSchema: {
        artifact: artifactArgument,
        baseVersion: z.number().int().min(1).describe("The number of the Version the save is based on."),
        title: z.string().min(1).optional(),
        description: z.string().optional(),
        page: artifactPathArgument.optional().describe("The path of the file that is its page."),
        files: artifactFiles.optional().describe("Files to add, or to replace at their paths."),
        remove: z.array(artifactPathArgument).optional().describe("Paths of files to remove."),
      },
    },
    ({ artifact, ...save }) => answer(() => send("PATCH", artifactPath(artifact), save)),
  );

  const decisionArgument = z
    .string()
    .min(1)
    .describe("The Decision's number, after its Project's key for a Project's (`CRONK/3`, or `3` for the Workspace's own); or its id.");
  const decisionPath = (decision: string) => `/api/decisions/${encodeURIComponent(decision)}`;

  server.registerTool(
    "list_decisions",
    {
      title: "List Decisions",
      description:
        "A Project's Decisions, or the Workspace's own when no Project is given, by number, without their bodies: " +
        "each with its status (proposed, accepted, rejected, deprecated or superseded) and, when superseded, the " +
        "Decision replacing it (`supersededById`). Read one with `read_decision`.",
      inputSchema: {
        project: z.string().optional().describe("A Project's key, such as `CRONK`. The Workspace's own when left out."),
      },
      annotations: { readOnlyHint: true },
    },
    ({ project }) => answer(async () => get(await placePath(project, "decisions"))),
  );

  server.registerTool(
    "read_decision",
    {
      title: "Read a Decision",
      description:
        "A Decision of your Workspace with its Markdown body, at its current Version, whose number a save names as its " +
        "`baseVersion`; or, given a Version's number, that earlier Version.",
      inputSchema: {
        decision: decisionArgument,
        version: z.number().int().min(1).optional().describe("An earlier Version's number. The current one when left out."),
      },
      annotations: { readOnlyHint: true },
    },
    ({ decision, version }) =>
      answer(() => get(version === undefined ? decisionPath(decision) : `${decisionPath(decision)}/versions/${version}`)),
  );

  server.registerTool(
    "list_decision_versions",
    {
      title: "List a Decision's Versions",
      description: "Each Version of a Decision, oldest first: its number, title, status, the Actor who saved it and when.",
      inputSchema: { decision: decisionArgument },
      annotations: { readOnlyHint: true },
    },
    ({ decision }) => answer(() => get(`${decisionPath(decision)}/versions`)),
  );

  server.registerTool(
    "compare_decision_versions",
    {
      title: "Compare two Versions of a Decision",
      description: "Both Versions, and their bodies compared line by line: each line `same`, `removed` or `added`.",
      inputSchema: {
        decision: decisionArgument,
        from: z.number().int().min(1).describe("The earlier Version's number."),
        to: z.number().int().min(1).describe("The later Version's number."),
      },
      annotations: { readOnlyHint: true },
    },
    ({ decision, from, to }) => answer(() => get(`${decisionPath(decision)}/versions/compare?from=${from}&to=${to}`)),
  );

  server.registerTool(
    "propose_decision",
    {
      title: "Propose a Decision",
      description:
        "Records a choice and its reasoning as a proposed Decision of a Project, or of the Workspace when no Project " +
        "is given, numbered next there, at Version 1 by your Agent. Only a User accepts, rejects or otherwise changes " +
        "its status.",
      inputSchema: {
        project: z.string().optional().describe("A Project's key, such as `CRONK`. The Workspace's own when left out."),
        title: z.string().min(1),
        body: z.string().optional().describe("Markdown: the context, the choice and its consequences."),
      },
    },
    ({ project, ...input }) => answer(async () => send("POST", await placePath(project, "decisions"), input)),
  );

  server.registerTool(
    "edit_decision",
    {
      title: "Save a Decision's text",
      description:
        "A new title or body saves a Decision as its next Version, by your Agent, based on the Version you read: give " +
        "its number as `baseVersion`. A save based on an outdated Version is refused with `outdated_version`, carrying " +
        "the current Version as `current`: merge your change into it and save again based on it. Accepted Decisions " +
        "stay editable. Only Users change a Decision's status, and nobody deletes one.",
      inputSchema: {
        decision: decisionArgument,
        baseVersion: z.number().int().min(1).describe("The number of the Version your save is based on."),
        title: z.string().min(1).optional(),
        body: z.string().optional().describe("The whole new body, in Markdown."),
      },
    },
    ({ decision, ...edit }) => answer(() => send("PATCH", decisionPath(decision), edit)),
  );

  server.registerTool(
    "export_knowledge",
    {
      title: "Export Terms and Decisions",
      description:
        "The files to commit into your branch: `GLOSSARY.md`, then `docs/adr/NNNN-<slug>.md` for each Decision by " +
        "number, each with its path and Markdown content. A Project's `GLOSSARY.md` is its glossary, its Terms over " +
        "the Workspace's, alphabetical, and its Decisions are its own; with no Project given, the Workspace's own " +
        "Terms and Decisions. Write each file at its path; Cronk never commits to a Repository itself.",
      inputSchema: {
        project: z.string().optional().describe("A Project's key, such as `CRONK`. The Workspace's own when left out."),
      },
      annotations: { readOnlyHint: true },
    },
    ({ project }) => answer(async () => get(await placePath(project, "export"))),
  );

  /** A Project of your Workspace by key, as the API answers it: with its Statuses in board order and their Steps. */
  const boardOf = async (key: string) => get<Project>(`/api/projects/${(await projectByKey(key)).id}`);

  /** The id of the Status named, ignoring case, or given by id, on the Project's board; refused naming its Statuses. */
  function statusIdOf(project: Project, status: string): string {
    const wanted = status.trim().toLowerCase();
    const found = project.statuses.find((s) => s.id === status.trim() || s.name.toLowerCase() === wanted);
    if (found) return found.id;
    throw new Refused({
      code: "unknown_status",
      message: `${project.key} has no Status named ${status}.`,
      rule: "A Status is named as it is on its Project's board, ignoring case, or by its id.",
      advice: `Use one of its Statuses: ${project.statuses.map((s) => s.name).join(", ")}.`,
    });
  }

  const projectArgument = z.string().min(1).describe("The Project's key, such as `CRONK`.");
  const statusArgument = z.string().min(1).describe("A Status of the Project: its name, ignoring case, or its id.");
  const statusKind = z
    .enum(["backlog", "active", "review", "done", "canceled"])
    .describe("What the Status means for its Tickets: `backlog`, `active`, `review`, `done` or `canceled`.");
  const position = z.number().int().min(0).describe("Its place on the board, counting from 0.");
  const boardRule =
    "Needs Write in the Project: the least of its Agent Access, your Owner's Access and your token's access. " +
    "Returns the Project with its Statuses and Steps.";

  server.registerTool(
    "read_project",
    {
      title: "Read a Project's board",
      description:
        "A Project of your Workspace with its settings, your Access in it (`write` or `read`) and its Statuses in " +
        "board order, each with its kind and its Step, if it has one: the Step's kind, Brief, model, round limit, " +
        "Label rule and Outcomes, each Outcome naming the id of the Status it moves Tickets to.",
      inputSchema: { project: projectArgument },
      annotations: { readOnlyHint: true },
    },
    ({ project }) => answer(() => boardOf(project)),
  );

  server.registerTool(
    "add_status",
    {
      title: "Add a Status",
      description:
        "Adds a Status to a Project's board, at a place or last. Refused for a name the board already has, " +
        `ignoring case. ${boardRule}`,
      inputSchema: {
        project: projectArgument,
        name: z.string().min(1).max(100),
        kind: statusKind,
        position: position.optional().describe("Its place on the board, counting from 0; last when left out."),
      },
    },
    ({ project, ...input }) =>
      answer(async () => send("POST", `/api/projects/${(await boardOf(project)).id}/statuses`, input)),
  );

  server.registerTool(
    "edit_status",
    {
      title: "Rename, move or change the kind of a Status",
      description:
        "Changes whichever of a Status's name, kind and place on the board are given. Refused if it would leave a " +
        "Status kind without a Status, if a Status with a Step would become Done or Canceled (remove its Step first), " +
        `and if an Outcome targeting it may not target its new kind. ${boardRule}`,
      inputSchema: {
        project: projectArgument,
        status: statusArgument,
        name: z.string().min(1).max(100).optional(),
        kind: statusKind.optional(),
        position: position.optional(),
      },
    },
    ({ project, status, ...edit }) =>
      answer(async () => {
        const board = await boardOf(project);
        return send("PATCH", `/api/projects/${board.id}/statuses/${statusIdOf(board, status)}`, edit);
      }),
  );

  server.registerTool(
    "remove_status",
    {
      title: "Remove a Status",
      description:
        "Removes a Status from a Project's board, with its Step. Refused while it holds Tickets (move them first), " +
        "while another Step's Outcome targets it, and if it is the board's only Status of its kind. " +
        boardRule,
      inputSchema: { project: projectArgument, status: statusArgument },
    },
    ({ project, status }) =>
      answer(async () => {
        const board = await boardOf(project);
        return send("DELETE", `/api/projects/${board.id}/statuses/${statusIdOf(board, status)}`);
      }),
  );

  server.registerTool(
    "set_step",
    {
      title: "Give a Status a Step, or change its Step",
      description:
        "Gives a Status this Step, replacing any it had: Tickets entering it get Runs. Refused on a Done or Canceled " +
        "Status. Exactly one Outcome is the default and exactly one, another, is *needs you*; neither may target a Done " +
        "or Canceled Status, no Outcome may target a Canceled Status, and *needs you* may not target the Status the Step " +
        "is on. A Step's Brief, model and Outcomes are what later Runs work by, so besides Write in the Project this " +
        "needs your Owner to be an Admin of the Workspace. Returns the Project with its Statuses and Steps.",
      inputSchema: {
        project: projectArgument,
        status: statusArgument,
        kind: z
          .enum(["ordinary", "merge"])
          .optional()
          .describe(
            "`ordinary` (when left out), or `merge`: a Merge Step skips itself by its default Outcome unless the Ticket " +
              "has Autonomous Delegation and its Project has agents may merge on.",
          ),
        brief: z.string().min(1).max(50_000).describe("Markdown; the middle of the Brief each Run starts from."),
        model: z.string().min(1).max(50).describe("The label of the model the Step wants, such as `haiku`, `sonnet` or `opus`."),
        roundLimit: z
          .number()
          .int()
          .min(0)
          .max(100)
          .optional()
          .describe("How many rounds an Outcome that counts as one may send the Ticket on before it goes to *needs you*; 2 when left out."),
        labelRule: z
          .object({
            kind: z.enum(["requires", "skippedBy"]).describe("`requires`: only Tickets with the Label pass. `skippedBy`: Tickets with it don't."),
            label: z.string().min(1).max(50),
          })
          .nullable()
          .optional()
          .describe("Which Tickets get a Run; every Ticket when left out. One that doesn't pass moves on by the default Outcome."),
        outcomes: z
          .array(
            z.object({
              name: z.string().min(1).max(50).describe("Unique within the Step, ignoring case."),
              status: statusArgument.describe("The Status it moves the Ticket to: its name, ignoring case, or its id."),
              default: z.boolean().optional().describe("Where a skipped Step sends the Ticket."),
              needsYou: z.boolean().optional().describe("Hands the Ticket back to its Assignee with a Question."),
              countsAsRound: z.boolean().optional().describe("Sends work back, counting toward the round limit."),
            }),
          )
          .min(2)
          .max(20),
      },
    },
    ({ project, status, outcomes, ...step }) =>
      answer(async () => {
        const board = await boardOf(project);
        return send("PUT", `/api/projects/${board.id}/statuses/${statusIdOf(board, status)}/step`, {
          ...step,
          outcomes: outcomes.map(({ status: target, ...outcome }) => ({
            name: outcome.name,
            statusId: statusIdOf(board, target),
            default: outcome.default ?? false,
            needsYou: outcome.needsYou ?? false,
            countsAsRound: outcome.countsAsRound ?? false,
          })),
        });
      }),
  );

  server.registerTool(
    "remove_step",
    {
      title: "Take a Status's Step off",
      description: `Takes the Step off a Status, so Tickets in it wait for a User instead of getting Runs. ${boardRule}`,
      inputSchema: { project: projectArgument, status: statusArgument },
    },
    ({ project, status }) =>
      answer(async () => {
        const board = await boardOf(project);
        return send("DELETE", `/api/projects/${board.id}/statuses/${statusIdOf(board, status)}/step`);
      }),
  );

  server.registerTool(
    "finish",
    {
      title: "Finish your Run",
      description:
        "Ends your running Run with one of the Outcomes its Brief offers, which moves its Ticket to the Outcome's " +
        "Status; a Status with a Step starts the next Run. Call it exactly once, as the last thing you do. " +
        "Refused for another Agent's Run, a Run that isn't running, a Run a User stopped by moving, undelegating " +
        "or re-delegating its Ticket, " +
        "and an Outcome the Run isn't offered. " +
        "This is the only way an Agent moves a Ticket: Agents never set a Status.",
      inputSchema: {
        run: z.string().min(1).describe("Your Run's id, as your Brief gives it."),
        outcome: z.string().min(1).describe("The Outcome's name, such as `ready`, ignoring case."),
        question: z.string().min(1).optional().describe("For *needs you*: what you need from the Ticket's Assignee."),
        report: z
          .string()
          .min(1)
          .optional()
          .describe("What you found or did, in Markdown; added to the Ticket's Reports, titled after your Run's Step."),
      },
    },
    ({ run, outcome, question, report }) =>
      answer(() => send("POST", `/api/runs/${encodeURIComponent(run)}/finish`, { outcome, question, report })),
  );

  server.registerTool(
    "merge_pull_request",
    {
      title: "Merge your Ticket's Pull Request",
      description:
        "For your running Run of a Merge Step: Cronk merges a Pull Request linked to your Run's Ticket on GitHub, with " +
        "its GitHub App and the Repository's default merge method. The merge ends your Run, finished as `merged`, and " +
        "completes the Ticket as Unverified for its Assignee: don't call `finish` after it. Refused, naming the rule and " +
        "what to do instead, unless the Ticket has Autonomous Delegation, its Project has agents may merge on, the Pull " +
        "Request is open, its checks on the latest commit are green with none pending, no review still requests " +
        "changes and GitHub says it is mergeable. Never merge on GitHub directly.",
      inputSchema: {
        run: z.string().min(1).describe("Your Run's id, as your Brief gives it."),
        pullRequest: z.number().int().describe("GitHub's id for the Pull Request, as `read_ticket` lists it under `pullRequests`."),
      },
    },
    ({ run, pullRequest }) =>
      answer(() => send("POST", `/api/runs/${encodeURIComponent(run)}/merge`, { pullRequestId: pullRequest })),
  );

  return server;
}

/** A tool's answer as JSON text; a refusal becomes an error result carrying its code, rule and advice. */
async function answer(work: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return { content: [{ type: "text", text: JSON.stringify(await work(), null, 2) }] };
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    return { isError: true, content: [{ type: "text", text: JSON.stringify(error.refusal, null, 2) }] };
  }
}
