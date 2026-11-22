/**
 * Where Cronk's MCP server answers. Apart from the routes, so that the Brief, Runner setups and OAuth can name it
 * without loading the MCP tools, which load the domain modules' body schemas.
 */
export const mcpPath = "/mcp";

/** Where an MCP client learns which authorization server guards the MCP server (RFC 9728). */
export const protectedResourcePath = `/.well-known/oauth-protected-resource${mcpPath}`;
