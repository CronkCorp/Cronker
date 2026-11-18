/**
 * Whose view of Cronk a read takes: a User sees the Workspaces they belong to, an Agent
 * only its own. Every lookup of a Workspace's records narrows by its Viewer, so records
 * out of view answer as if they didn't exist.
 */
export type Viewer = { kind: "user"; id: string } | { kind: "agent"; id: string; workspace: { id: string } };

export const userViewer = (userId: string): Viewer => ({ kind: "user", id: userId });

/**
 * A SQL condition that the Workspace in `workspaceColumn` is in the Viewer's view, with
 * the value to bind to `param`.
 */
export function inView(viewer: Viewer, workspaceColumn: string, param: string): { sql: string; value: string } {
  return viewer.kind === "user"
    ? {
        sql: `exists (select 1 from memberships where memberships.workspace_id = ${workspaceColumn} and memberships.user_id = ${param})`,
        value: viewer.id,
      }
    : { sql: `${workspaceColumn} = ${param}`, value: viewer.workspace.id };
}
