/** Where Cronk's MCP server answers, on its public address. */
export const mcpPath = "/mcp";

/** Where an MCP client learns which authorization server guards the MCP server (RFC 9728). */
export const protectedResourcePath = `/.well-known/oauth-protected-resource${mcpPath}`;
