import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Guidance } from "../http/errors.js";
import { isUuid } from "../http/ids.js";

/**
 * Cronk's MCP tools for an Agent. They hold no rules of their own: each calls the HTTP
 * API as the Agent, through `Api`, and passes on whatever the API answers, refusals included.
 */

/** A request to Cronk's HTTP API, made as the Agent. */
export type Api = (method: string, path: string, body?: unknown) => Promise<{ status: number; json: unknown }>;

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
  "Agents may read their Workspace, comment on its Tickets and finish their own Runs; anything else is refused with the rule and what to do instead.";

export function buildMcpServer(api: Api): McpServer {
  const server = new McpServer(
    { name: "Cronk", version: "0.0.0" },
    { instructions: `Cronk tracks Tickets for Users and their Agents. You act as one Agent. ${rights}` },
  );

  async function get<T>(path: string): Promise<T> {
    return send<T>("GET", path);
  }

  async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
    const { status, json } = await api(method, path, body);
    if (status >= 400) throw new Refused((json as { error: Refusal }).error);
    return json as T;
  }

  let workspace: Promise<Workspace> | undefined;
  const ownWorkspace = () => (workspace ??= get<{ workspace: Workspace }>("/api/agent").then((me) => me.workspace));

  async function ticketByKeyOrId(ticket: string) {
    if (isUuid(ticket)) return get<{ id: string; key: string }>(`/api/tickets/${ticket}`);
    const { id } = await ownWorkspace();
    return get<{ id: string; key: string }>(`/api/workspaces/${id}/tickets/${encodeURIComponent(ticket)}`);
  }

  server.registerTool(
    "read_ticket",
    {
      title: "Read a Ticket",
      description:
        "A Ticket of your Workspace with its fields, its Comments (oldest first), its Relations: " +
        "the Tickets it blocks, is blocked by and relates to, its parent and its Sub-Tickets; and its Runs, oldest first. " +
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
        const { id } = await ownWorkspace();
        const projects = await get<ProjectSummary[]>(`/api/workspaces/${id}/projects`);
        const chosen = filter.project
          ? projects.filter((p) => p.key.toLowerCase() === filter.project!.trim().toLowerCase())
          : projects;
        if (chosen.length === 0 && filter.project) {
          throw new Refused({
            code: "unknown_project",
            message: `Your Workspace has no Project with the key ${filter.project}.`,
            rule: "A Project is named by its key, among the Projects of your Workspace.",
            advice: `Use one of these keys, or leave the Project out: ${projects.map((p) => p.key).join(", ") || "(none yet)"}.`,
          });
        }
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
        report: z.string().min(1).optional().describe("What you found or did, in Markdown."),
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
