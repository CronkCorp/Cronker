/**
 * Where Cronk's MCP server answers. Kept apart from its routes, so a module needing only an address doesn't import
 * the MCP tools, and with them the route bodies they are built from, in a cycle.
 */

/** Where Cronk's MCP server answers, on its public address. */
export const mcpPath = "/mcp";

/** Where an MCP client learns which authorization server guards the MCP server (RFC 9728). */
export const protectedResourcePath = `/.well-known/oauth-protected-resource${mcpPath}`;
