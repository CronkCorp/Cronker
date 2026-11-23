import type { InboxItem } from "./api.js";

/** The Inbox's groups, in the order they are worked through; `value` names the group in the address's `kind=`. */
export const inboxGroups: { name: string; value: string; kinds: InboxItem["kind"][] }[] = [
  { name: "Questions", value: "question", kinds: ["question"] },
  { name: "Needs you", value: "needs-you", kinds: ["needsYou", "reassign", "undelegated"] },
  { name: "Runs gone wrong", value: "run", kinds: ["run"] },
  { name: "To review", value: "review", kinds: ["review"] },
  { name: "Unverified", value: "unverified", kinds: ["unverified"] },
  { name: "Discovered", value: "discovered", kinds: ["discovered"] },
];

/** The Project option for items of no Project, such as the Workspace's own knowledge. */
export const workspaceOption = "workspace";

/** The Inbox's filters: the Project keys (or `workspace`) and kinds chosen. Empty means not filtered by it. */
export interface InboxFilters {
  projects: string[];
  kinds: string[];
}

export const noFilters: InboxFilters = { projects: [], kinds: [] };

export const filtering = (filters: InboxFilters) => filters.projects.length > 0 || filters.kinds.length > 0;

/** The values of a repeated or comma-separated parameter, each once, in order. */
function values(params: URLSearchParams, name: string): string[] {
  const all = params
    .getAll(name)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value !== "");
  return [...new Set(all)];
}

/**
 * The filters an address asks for (`project=CRONK&project=WEB&kind=question`, or comma-separated). Project keys
 * are read in any letter case; a kind the Inbox doesn't have is ignored.
 */
export function readFilters(search: string): InboxFilters {
  const params = new URLSearchParams(search);
  const projects = [
    ...new Set(values(params, "project").map((key) => (key.toLowerCase() === workspaceOption ? workspaceOption : key.toUpperCase()))),
  ];
  const known = new Set(inboxGroups.map((g) => g.value));
  const kinds = values(params, "kind")
    .map((kind) => kind.toLowerCase())
    .filter((kind) => known.has(kind));
  return { projects, kinds: [...new Set(kinds)] };
}

/** The address's parameters with these filters in place of any it had, keeping the others (such as `item=`). */
export function withFilters(search: string, filters: InboxFilters): string {
  const params = new URLSearchParams(search);
  params.delete("project");
  params.delete("kind");
  for (const project of filters.projects) params.append("project", project);
  for (const kind of filters.kinds) params.append("kind", kind);
  return params.toString();
}

/** The key of an item's Project, from its Ticket's key, or `workspace` for an item of no Project. */
export function projectOf(item: InboxItem): string {
  const key = item.ticket?.key;
  if (!item.ticket?.projectId || !key || !key.includes("-")) return workspaceOption;
  return key.slice(0, key.lastIndexOf("-")).toUpperCase();
}

/** The value of an item's group, as `kind=` names it. */
export function groupOf(item: InboxItem): string | undefined {
  return inboxGroups.find((g) => g.kinds.includes(item.kind))?.value;
}

/** Whether an item shows under these filters: in one of the chosen Projects, if any, and of one of the chosen kinds, if any. */
export function matches(item: InboxItem, filters: InboxFilters): boolean {
  if (filters.projects.length > 0 && !filters.projects.includes(projectOf(item))) return false;
  if (filters.kinds.length > 0 && !filters.kinds.includes(groupOf(item) ?? "")) return false;
  return true;
}
