import { createContext, useContext, useEffect, useMemo } from "react";
import type { ProjectSummary } from "./api.js";
import { replace } from "./router.js";

/**
 * The web client's addresses, all built here. Every page of a Workspace is under its slug:
 *
 * - `/<workspace>`, and its own pages: `inbox`, `search`, `documents`, `glossary`, `decisions`, `artifacts`,
 *   `agents`, `agents/<agent id>`, `members`, `settings`
 * - `/<workspace>/projects/<KEY>`, its board, and its pages: `list`, `releases`, `settings`, `documents`, `glossary`,
 *   `decisions`, `artifacts`
 * - `/<workspace>/tickets/<KEY>-<n>`
 * - `/<workspace>/decisions/<n>` for the Workspace's own, `/<workspace>/projects/<KEY>/decisions/<n>` for a Project's
 * - `/<workspace>/glossary/<name>` and `/<workspace>/projects/<KEY>/glossary/<name>` for Terms
 * - `/<workspace>/documents/<slug>`, `/<workspace>/artifacts/<slug>`, `/<workspace>/transcripts/<slug>`
 *
 * The pages of no Workspace (`/runners`, `/github`, `/password`, `/workspaces/new`) keep their addresses.
 */

/** A Workspace as addresses name it. */
export interface WorkspaceRef {
  slug: string;
}

export type WorkspacePage =
  | "inbox"
  | "search"
  | "documents"
  | "glossary"
  | "decisions"
  | "artifacts"
  | "agents"
  | "members"
  | "settings";

export type ProjectView = "list" | "releases" | "settings" | "documents" | "glossary" | "decisions" | "artifacts";

const part = encodeURIComponent;

export const addresses = {
  workspace: (workspace: WorkspaceRef, page?: WorkspacePage) => `/${workspace.slug}${page ? `/${page}` : ""}`,
  agent: (workspace: WorkspaceRef, agentId: string) => `/${workspace.slug}/agents/${part(agentId)}`,
  project: (workspace: WorkspaceRef, key: string, view?: ProjectView) =>
    `/${workspace.slug}/projects/${part(key.toUpperCase())}${view ? `/${view}` : ""}`,
  /** A Project's page of a kind of knowledge, or the Workspace's own when the Project's key is null. */
  knowledge: (workspace: WorkspaceRef, key: string | null, kind: "documents" | "glossary" | "decisions" | "artifacts") =>
    key === null ? addresses.workspace(workspace, kind) : addresses.project(workspace, key, kind),
  ticket: (workspace: WorkspaceRef, key: string) => `/${workspace.slug}/tickets/${part(key.toUpperCase())}`,
  decision: (workspace: WorkspaceRef, key: string | null, number: number) =>
    `${addresses.knowledge(workspace, key, "decisions")}/${number}`,
  term: (workspace: WorkspaceRef, key: string | null, name: string) =>
    `${addresses.knowledge(workspace, key, "glossary")}/${part(name)}`,
  document: (workspace: WorkspaceRef, slug: string) => `/${workspace.slug}/documents/${part(slug)}`,
  artifact: (workspace: WorkspaceRef, slug: string) => `/${workspace.slug}/artifacts/${part(slug)}`,
  transcript: (workspace: WorkspaceRef, slug: string) => `/${workspace.slug}/transcripts/${part(slug)}`,
  search: (workspace: WorkspaceRef, query: string) => `/${workspace.slug}/search?${query}`,
};

/** The Workspace on screen and its Projects, which the addresses of its pages are built from. */
export interface AddressBook {
  workspace: (WorkspaceRef & { id: string }) | null;
  projects: ProjectSummary[] | null;
  /** The Project the page on screen is in, as it tells the frame, or null. */
  projectId: string | null;
}

export const AddressContext = createContext<AddressBook>({ workspace: null, projects: null, projectId: null });

/**
 * Builds the addresses of the Workspace on screen's pages, from the records the page shows. A Decision or Term names
 * its Project by id, whose key comes from the Workspace's Projects.
 */
export function useAddresses() {
  const { workspace, projects } = useContext(AddressContext);
  return useMemo(() => {
    const ws: WorkspaceRef = workspace ?? { slug: "" };
    const keyOf = (projectId: string | null) =>
      projectId === null ? null : (projects?.find((p) => p.id === projectId)?.key ?? null);
    /** The page of something whose Project isn't known yet: its old id address, which leads to the readable one. */
    const byId = (kind: string, id: string) => `/${kind}/${part(id)}`;
    return {
      workspace: (page?: WorkspacePage) => addresses.workspace(ws, page),
      agent: (agentId: string) => addresses.agent(ws, agentId),
      project: (project: { key: string }, view?: ProjectView) => addresses.project(ws, project.key, view),
      knowledge: (project: { key: string } | null, kind: "documents" | "glossary" | "decisions" | "artifacts") =>
        addresses.knowledge(ws, project?.key ?? null, kind),
      /** A page tree's, glossary's, Decisions' or Artifacts' page of a Project, by its id, or of the Workspace. */
      place: (place: { kind: "project" | "workspace"; id: string }, kind: "documents" | "glossary" | "decisions" | "artifacts") => {
        if (place.kind === "workspace") return addresses.workspace(ws, kind);
        const key = keyOf(place.id);
        return key === null ? `${byId("projects", place.id)}/${kind}` : addresses.project(ws, key, kind);
      },
      ticket: (ticket: { key: string }) => addresses.ticket(ws, ticket.key),
      decision: (decision: { id: string; projectId: string | null; number: number }) => {
        const key = keyOf(decision.projectId);
        return decision.projectId !== null && key === null
          ? byId("decisions", decision.id)
          : addresses.decision(ws, key, decision.number);
      },
      term: (term: { id: string; projectId: string | null; name: string }) => {
        const key = keyOf(term.projectId);
        return term.projectId !== null && key === null ? byId("terms", term.id) : addresses.term(ws, key, term.name);
      },
      document: (document: { slug: string }) => addresses.document(ws, document.slug),
      artifact: (artifact: { slug: string }) => addresses.artifact(ws, artifact.slug),
      transcript: (transcript: { slug: string }) => addresses.transcript(ws, transcript.slug),
      search: (query: string) => addresses.search(ws, query),
    };
  }, [workspace, projects]);
}

export type Addresses = ReturnType<typeof useAddresses>;

/**
 * Keeps the address shown the page's canonical one as what it shows changes, such as a Document's slug after a
 * rename or a Term's name, replacing it in the history. An address not yet readable (its Project's key not loaded)
 * is left for later.
 */
export function useCanonicalAddress(address: string | null) {
  const { workspace } = useContext(AddressContext);
  useEffect(() => {
    if (!address || !workspace || !address.startsWith(`/${workspace.slug}/`)) return;
    settle(address);
  }, [address, workspace]);
}

/** Moves to an address in place of the one shown, keeping the query and fragment, unless it is the one shown. */
export function settle(address: string) {
  if (address !== window.location.pathname) replace(`${address}${window.location.search}${window.location.hash}`);
}
