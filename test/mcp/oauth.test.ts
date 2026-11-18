import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { navigate, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

/**
 * Seam 4, kept thin: a real MCP client connects through OAuth, as a claude.ai connector
 * does, with the consent screen picking one of the User's Agents. The rules of the flow
 * are tested at the API.
 */

let cronk: StartedCronk;
const clients: Client[] = [];
beforeEach(async () => {
  cronk = await startCronk();
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await cronk?.stop();
});

const callback = "https://claude.ai/api/mcp/auth_callback";

/** An MCP client's OAuth state, kept in memory; the browser is whoever opens `authorizationUrl`. */
class ConnectorProvider implements OAuthClientProvider {
  authorizationUrl?: URL;
  private information?: OAuthClientInformationMixed;
  private saved?: OAuthTokens;
  private verifier = "";

  constructor(readonly clientMetadataUrl?: string) {}

  get redirectUrl() {
    return callback;
  }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: "Claude", redirect_uris: [callback], token_endpoint_auth_method: "none" };
  }
  clientInformation() {
    return this.information;
  }
  saveClientInformation(information: OAuthClientInformationMixed) {
    this.information = information;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    return this.verifier;
  }
}

function transportFor(provider: ConnectorProvider) {
  return new StreamableHTTPClientTransport(new URL("/mcp", cronk.url), { authProvider: provider });
}

async function connect(provider: ConnectorProvider) {
  const client = new Client({ name: "cronk-test", version: "0.0.0" });
  await client.connect(transportFor(provider));
  clients.push(client);
  return client;
}

/** Ada's Workspace with a Ticket CRONK-1, and an Agent of hers. */
async function workspaceWithTicket() {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const post = async (path: string, body: unknown) => (await cronk.request("POST", path, { cookie, body })).json();
  const project = await post(`/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  const ticket = await post(`/api/projects/${project.id}/tickets`, { title: "Read me" });
  const agent = await post(`/api/workspaces/${workspace.id}/agents`, { name: "claude-max" });
  return { cookie, ticket, agent };
}

/**
 * The browser opens the authorization URL, Cronk sends it to its consent screen, and the
 * signed-in User picks the Agent there; Cronk sends the browser back to the client with a code.
 */
async function consent(provider: ConnectorProvider, cookie: string, agentId: string) {
  const atCronk = await navigate(provider.authorizationUrl!.href);
  expect(atCronk.status).toBe(302);
  const consentPage = new URL(atCronk.headers.get("location")!, cronk.url);
  expect(consentPage.pathname).toBe("/connect");
  const requestId = consentPage.searchParams.get("request")!;

  const approved = await cronk.request("POST", `/api/oauth/requests/${requestId}/approve`, {
    cookie,
    body: { agentId },
  });
  expect(approved.status).toBe(200);
  const back = new URL((await approved.json()).redirectTo);
  expect(`${back.origin}${back.pathname}`).toBe(callback);
  return back.searchParams.get("code")!;
}

describe("MCP with OAuth", () => {
  test("a connector registers itself, and once the User picks an Agent it acts as that Agent", async () => {
    const { cookie, ticket, agent } = await workspaceWithTicket();
    const provider = new ConnectorProvider();

    await expect(connect(provider)).rejects.toThrow(UnauthorizedError);
    const code = await consent(provider, cookie, agent.id);
    await transportFor(provider).finishAuth(code);
    const client = await connect(provider);

    const result = await client.callTool({ name: "comment", arguments: { ticket: "CRONK-1", body: "Connected." } });
    expect(result.isError ?? false).toBe(false);
    const comments = await (await cronk.request("GET", `/api/tickets/${ticket.id}/comments`, { cookie })).json();
    expect(comments).toEqual([
      expect.objectContaining({ body: "Connected.", actor: { kind: "agent", id: agent.id, name: "claude-max" } }),
    ]);
  });
});
