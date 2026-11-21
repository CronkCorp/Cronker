import { useEffect, useState, type ReactNode } from "react";
import { api, type WorkspaceSummary } from "./api.js";
import { addresses, settle, type ProjectView, type WorkspacePage } from "./addresses.js";

/** A page of a Workspace, as its readable address names it. */
export type Route =
  | { kind: "workspace"; page?: WorkspacePage }
  | { kind: "agent"; agentId: string }
  | { kind: "project"; key: string; view?: ProjectView }
  | { kind: "ticket"; key: string }
  | { kind: "decision"; key: string | null; number: number }
  | { kind: "term"; key: string | null; name: string }
  | { kind: "document" | "artifact" | "transcript"; slug: string };

const workspacePages: WorkspacePage[] = ["inbox", "search", "documents", "glossary", "decisions", "artifacts", "agents", "members", "settings"];
const projectViews: ProjectView[] = ["list", "settings", "documents", "glossary", "decisions", "artifacts"];

/** An address's parts, decoded; null for one that can't be decoded. */
function partsOf(path: string): string[] | null {
  try {
    return path.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
}

/** The Workspace slug and page a readable address names, or null for an address that is no Workspace's page. */
export function parseAddress(path: string): { slug: string; route: Route | null } | null {
  const parts = partsOf(path);
  if (!parts || parts.length === 0) return null;
  const [slug, ...rest] = parts as [string, ...string[]];
  const number = (text: string | undefined) => (text && /^[1-9][0-9]{0,8}$/.test(text) ? Number(text) : null);
  const route = ((): Route | null => {
    const [first, second, third, fourth] = rest;
    if (rest.length === 0) return { kind: "workspace" };
    if (rest.length === 1 && workspacePages.includes(first as WorkspacePage)) return { kind: "workspace", page: first as WorkspacePage };
    if (rest.length === 2 && first === "agents") return { kind: "agent", agentId: second! };
    if (first === "projects" && second) {
      if (rest.length === 2) return { kind: "project", key: second };
      if (rest.length === 3 && projectViews.includes(third as ProjectView)) return { kind: "project", key: second, view: third as ProjectView };
      if (rest.length === 4 && third === "decisions" && number(fourth)) return { kind: "decision", key: second, number: number(fourth)! };
      if (rest.length === 4 && third === "glossary") return { kind: "term", key: second, name: fourth! };
      return null;
    }
    if (rest.length !== 2) return null;
    if (first === "tickets") return { kind: "ticket", key: second! };
    if (first === "decisions" && number(second)) return { kind: "decision", key: null, number: number(second)! };
    if (first === "glossary") return { kind: "term", key: null, name: second! };
    if (first === "documents" || first === "artifacts" || first === "transcripts") {
      return { kind: first.slice(0, -1) as "document" | "artifact" | "transcript", slug: second! };
    }
    return null;
  })();
  return { slug, route };
}

/** What a page's address resolved to: the id of what it shows, or a failure. */
type Resolution = { id: string } | { failed: true } | null;

/**
 * Finds what an address names, moving to its canonical address (the right letter case, the current slug) if it isn't
 * already there, then shows the page for its id.
 */
export function Resolve({
  find,
  name,
  children,
  failed,
}: {
  /** Finds what the address names: its id and its canonical address. */
  find: () => Promise<{ id: string; address: string }>;
  /** What changes the address names; finding runs again when it changes. */
  name: string;
  children: (id: string) => ReactNode;
  failed: ReactNode;
}) {
  const [resolution, setResolution] = useState<Resolution>(null);
  useEffect(() => {
    // What was shown stays until the new address is found: when it names the same thing, as after a rename moves the
    // address to the new canonical one, the page stays as it is.
    let current = true;
    find().then(
      ({ id, address }) => {
        if (!current) return;
        settle(address);
        setResolution({ id });
      },
      () => current && setResolution({ failed: true }),
    );
    return () => {
      current = false;
    };
    // `find` is made anew each render; what it finds changes only with `name`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);
  if (!resolution) return <div className="page" aria-busy="true" />;
  if ("failed" in resolution) return <>{failed}</>;
  return <>{children(resolution.id)}</>;
}

/** Finds what a readable address of the Workspace names, and its canonical address. */
export function finder(workspace: WorkspaceSummary, route: Route): (() => Promise<{ id: string; address: string }>) | null {
  const projectByKey = async (key: string) => {
    const project = (await api.projects(workspace.id)).find((p) => p.key.toLowerCase() === key.toLowerCase());
    if (!project) throw new Error("No such Project.");
    return project;
  };
  const place = async (key: string | null) =>
    key === null ? { tree: { kind: "workspace" as const, id: workspace.id }, key: null } : await projectByKey(key).then((p) => ({ tree: { kind: "project" as const, id: p.id }, key: p.key }));
  const elsewhere = (workspaceId: string) => {
    if (workspaceId !== workspace.id) throw new Error("Of another Workspace.");
  };
  switch (route.kind) {
    case "project":
      return async () => {
        const project = await projectByKey(route.key);
        return { id: project.id, address: addresses.project(workspace, project.key, route.view) };
      };
    case "ticket":
      return async () => {
        const ticket = await api.ticketByKey(workspace.id, route.key.toUpperCase());
        return { id: ticket.id, address: addresses.ticket(workspace, ticket.key) };
      };
    case "decision":
      return async () => {
        const { tree, key } = await place(route.key);
        const decision = (await api.decisions(tree)).find((d) => d.number === route.number);
        if (!decision) throw new Error("No such Decision.");
        return { id: decision.id, address: addresses.decision(workspace, key, decision.number) };
      };
    case "term":
      return async () => {
        const { tree, key } = await place(route.key);
        const term = (await api.terms(tree)).find((t) => t.name.toLowerCase() === route.name.toLowerCase());
        if (!term) throw new Error("No such Term.");
        return { id: term.id, address: addresses.term(workspace, key, term.name) };
      };
    case "document":
      return async () => {
        const document = await api.document(route.slug);
        elsewhere(document.workspaceId);
        return { id: document.id, address: addresses.document(workspace, document.slug) };
      };
    case "artifact":
      return async () => {
        const artifact = await api.artifact(route.slug);
        elsewhere(artifact.workspaceId);
        return { id: artifact.id, address: addresses.artifact(workspace, artifact.slug) };
      };
    case "transcript":
      return async () => {
        const transcript = await api.transcript(route.slug);
        elsewhere(transcript.workspaceId);
        return { id: transcript.id, address: addresses.transcript(workspace, transcript.slug) };
      };
    default:
      return null;
  }
}

/**
 * The readable address of an old one, which named things by their ids (`/tickets/<id>`, `/workspaces/<id>/inbox`):
 * found through the API, or null when it names nothing the User sees. Undefined for an address that isn't an old one.
 */
export function oldAddress(path: string, workspaces: WorkspaceSummary[]): (() => Promise<string | null>) | undefined {
  const parts = partsOf(path);
  if (!parts || parts.length < 2) return undefined;
  const [kind, id, ...rest] = parts as [string, string, ...string[]];
  const slugOf = (workspaceId: string) => {
    const workspace = workspaces.find((w) => w.id === workspaceId);
    if (!workspace) throw new Error("Not a Workspace of the User's.");
    return workspace;
  };
  const keyOf = async (projectId: string | null) => (projectId === null ? null : (await api.project(projectId)).key);
  const found = (address: () => Promise<string>) => () => address().catch(() => null);
  switch (kind) {
    case "workspaces":
      if (id === "new") return undefined;
      return found(async () => [addresses.workspace(slugOf(id)), ...rest.map(encodeURIComponent)].join("/"));
    case "projects":
      if (rest.length > 1) return undefined;
      return found(async () => {
        const project = await api.project(id);
        return addresses.project(slugOf(project.workspaceId), project.key, rest[0] as ProjectView | undefined);
      });
    case "tickets":
      return found(async () => {
        const ticket = await api.ticket(id);
        const project = await api.project(ticket.projectId);
        return addresses.ticket(slugOf(project.workspaceId), ticket.key);
      });
    case "decisions":
      return found(async () => {
        const decision = await api.decision(id);
        return addresses.decision(slugOf(decision.workspaceId), await keyOf(decision.projectId), decision.number);
      });
    case "terms":
      return found(async () => {
        const term = await api.term(id);
        return addresses.term(slugOf(term.workspaceId), await keyOf(term.projectId), term.name);
      });
    case "documents":
      return found(async () => {
        const document = await api.document(id);
        return addresses.document(slugOf(document.workspaceId), document.slug);
      });
    case "artifacts":
      return found(async () => {
        const artifact = await api.artifact(id);
        return addresses.artifact(slugOf(artifact.workspaceId), artifact.slug);
      });
    case "transcripts":
      return found(async () => {
        const transcript = await api.transcript(id);
        return addresses.transcript(slugOf(transcript.workspaceId), transcript.slug);
      });
    default:
      return undefined;
  }
}

/** Moves an old address to its readable one, replacing it in the history; shows `failed` if it names nothing. */
export function OldAddress({ find, failed }: { find: () => Promise<string | null>; failed: ReactNode }) {
  const [failure, setFailure] = useState(false);
  useEffect(() => {
    let current = true;
    find().then((address) => {
      if (!current) return;
      if (address) settle(address);
      else setFailure(true);
    });
    return () => {
      current = false;
    };
    // Runs once per old address; App keys this by the address.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return failure ? <>{failed}</> : <div className="page" aria-busy="true" />;
}
