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
  "and Terms), and propose Decisions and edit their text (only Users change a Decision's status). During your " +
  "running Run on a Ticket you may also edit its description, Priority, Labels, due date and estimate, attach files to it, split it into Sub-Tickets, write Reports on it, link Documents to it and unlink " +
  "them, and finish the Run. A Ticket you file outside your Ticket's Sub-Tickets is a Discovered Ticket, waiting for " +
  "its Assignee: until a User delegates, moves or dismisses it you may edit it, title included, and add blocks from " +
  "it. Anything else is refused with the rule and what to do instead.";

export function buildMcpServer(api: Api): McpServer {
  const server = new McpServer(
    { name: "Cronk", version: "0.0.0" },
    {
      instructions:
        "Cronk tracks Tickets for Users and their Agents, and keeps written knowledge as Documents in the page tree of " +
        "each Project and of the Workspace, as Terms in their glossaries (a Project's glossary is its Terms over the " +
        "Workspace's), and recorded choices as numbered Decisions of each Project and of the Workspace. You act as one " +
        `Agent. ${rights}`,
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
        "A Ticket of your Workspace with its fields, its Comments (oldest first), its Relations: " +
        "the Tickets it blocks, is blocked by and relates to, its parent and its Sub-Tickets; its Runs, oldest first; " +
        "the Reports its Runs wrote, oldest first, which a Run on the Ticket builds on; its Linked Documents, " +
        "Documents of its Project or the Workspace that the work needs, which you read with `read_document`; and the " +
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
          linkedDocuments: await get(`/api/tickets/${found.id}/documents`),
          attachments: await get(`/api/tickets/${found.id}/attachments`),
        };
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
      title: "Comment on a Ticket",
      description:
        "Adds a Markdown Comment to a Ticket of your Workspace, as your Agent, or a reply to one of its Comments. " +
        "Refused for a read-only token; a Ticket outside your Workspace answers as not found, and a reply only goes " +
        "to a Comment on the same Ticket.",
      inputSchema: {
        ticket: ticketArgument,
        body: z.string().min(1).describe("Markdown."),
        replyToId: z.string().optional().describe("The id of the Comment on this Ticket being replied to."),
      },
    },
    ({ ticket, body, replyToId }) =>
      answer(async () => {
        const found = await ticketByKeyOrId(ticket);
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
      title: "Split your Run's Ticket into a Sub-Ticket",
      description:
        "During your running Run on a Ticket, creates a Sub-Ticket of it in the same Project's first Backlog Status, " +
        "with its Assignee and Delegation. The Ticket gets no Runs while a Sub-Ticket is unfinished. Refused for any " +
        "other Ticket and outside a running Run.",
      inputSchema: {
        ticket: ticketArgument.describe("Your Run's Ticket, the parent: its key, such as `CRONK-12`, or its id."),
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
        "dismisses it you may edit it with `edit_ticket` and add blocks from it with `add_block`. To split your own " +
        "Ticket's work, use `create_sub_ticket` instead.",
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
      title: "Block a Ticket by your Discovered Ticket",
      description:
        "Marks that a Discovered Ticket you filed blocks another Ticket of your Workspace, which then gets no Runs " +
        "until it is finished. Refused for any other Ticket, once a User has delegated, moved or dismissed it, and for " +
        "a block that would form a cycle.",
      inputSchema: {
        ticket: ticketArgument.describe("Your Discovered Ticket: its key, such as `CRONK-12`, or its id."),
        blocks: ticketArgument.describe("The Ticket it blocks: its key, such as `CRONK-12`, or its id."),
      },
    },
    ({ ticket, blocks }) =>
      answer(async () => {
        const found = await ticketByKeyOrId(ticket);
        const other = isUuid(blocks) ? { ticketId: blocks } : { ticketKey: blocks };
        return send("POST", `/api/tickets/${found.id}/relations`, { kind: "blocks", ...other });
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

  const documentArgument = z.string().min(1).describe("The Document's id.");

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
        parent: z.string().optional().describe("The id of a Document of the same page tree to sit under."),
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
          .describe("The id of a Document of the same page tree to sit under, or null for the top."),
        position: z.number().int().min(0).optional().describe("A place among its siblings, counting from 0."),
      },
    },
    ({ document, parent, ...edit }) => answer(() => send("PATCH", documentPath(document), { ...edit, parentId: parent })),
  );

  const termArgument = z.string().min(1).describe("The Term's id.");
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
      description: "A Term at its current Version, whose number a save names as its `baseVersion`.",
      inputSchema: { term: termArgument },
      annotations: { readOnlyHint: true },
    },
    ({ term }) => answer(() => get(termPath(term))),
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
      title: "Link a Document to your Run's Ticket",
      description:
        "During your running Run on a Ticket, links a Document of the Ticket's Project or of the Workspace to it, so " +
        "it is one click away for its Users and later Runs read it with the Ticket. Refused for a Document of another " +
        "Project, for any other Ticket and outside a running Run.",
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
      title: "Unlink a Document from your Run's Ticket",
      description:
        "During your running Run on a Ticket, unlinks one of its Linked Documents; the Document stays in its page " +
        "tree. Answers with the Ticket's Linked Documents left. Refused for any other Ticket and outside a running Run.",
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
        document: z.string().min(1).optional().describe("A Document's id."),
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

  const decisionArgument = z.string().min(1).describe("The Decision's id.");
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
