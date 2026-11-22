/**
 * Where an Artifact's file is served in the sandbox. Kept in a module of its own, importing nothing, so
 * `work/mentions.ts` can use it without loading `artifacts.ts`, whose imports reach the MCP tools, which build their
 * schemas from the Mention schema while `mentions.ts` is still loading.
 */
export const sandboxPath = (key: string, path = "") => `/sandbox/${key}/${path.split("/").map(encodeURIComponent).join("/")}`;
