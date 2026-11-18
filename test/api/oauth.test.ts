import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

/**
 * Cronk as the OAuth 2.1 authorization server for its MCP server, so a claude.ai connector
 * connects as one of a User's Agents without a token in any Brief.
 */

let cronk: StartedCronk;
beforeEach(async () => {
  cronk = await startCronk();
});
afterEach(async () => {
  await cronk?.stop();
});

describe("discovery", () => {
  test("the MCP server names its authorization server, and a request without a token points to it", async () => {
    const resource = await cronk.request("GET", "/.well-known/oauth-protected-resource/mcp");
    expect(resource.status).toBe(200);
    expect(await resource.json()).toEqual(
      expect.objectContaining({ resource: `${cronk.url}/mcp`, authorization_servers: [cronk.url] }),
    );

    const refused = await cronk.request("POST", "/mcp", {
      body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    });
    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate")).toContain(
      `resource_metadata="${cronk.url}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  test("the authorization server describes its endpoints, PKCE, registration and Client ID Metadata Documents", async () => {
    const response = await cronk.request("GET", "/.well-known/oauth-authorization-server");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        issuer: cronk.url,
        authorization_endpoint: `${cronk.url}/oauth/authorize`,
        token_endpoint: `${cronk.url}/oauth/token`,
        registration_endpoint: `${cronk.url}/oauth/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        client_id_metadata_document_supported: true,
      }),
    );
  });
});
