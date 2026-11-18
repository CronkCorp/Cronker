import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { hours } from "../harness/clock.js";
import { addMember, navigate, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

/**
 * Cronk as the OAuth 2.1 authorization server for its MCP server, so a claude.ai connector
 * connects as one of a User's Agents without a token in any Brief.
 */

let cronk: StartedCronk;
const servers: Server[] = [];
beforeEach(async () => {
  cronk = await startCronk();
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
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

const callback = "https://claude.ai/api/mcp/auth_callback";

async function register(metadata: object = { client_name: "Claude", redirect_uris: [callback] }) {
  const response = await cronk.request("POST", "/oauth/register", { body: metadata });
  expect(response.status).toBe(201);
  return (await response.json()) as { client_id: string };
}

/** Posts a form to the token endpoint, as an OAuth client does. */
function token(params: Record<string, string>) {
  return fetch(`${cronk.url}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
}

/** A PKCE verifier and its S256 challenge. */
function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** The browser opens the authorization URL; returns where Cronk sends it. */
async function authorize(params: Record<string, string>) {
  const url = new URL("/oauth/authorize", cronk.url);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  const response = await navigate(url.href);
  expect(response.status).toBe(302);
  return new URL(response.headers.get("location")!, cronk.url);
}

/** A client asks to connect, as a claude.ai connector does; returns the consent screen's request id. */
async function requestConnection(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  const consentPage = await authorize({
    client_id: clientId,
    redirect_uri: callback,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz",
    resource: `${cronk.url}/mcp`,
    ...extra,
  });
  expect(consentPage.pathname).toBe("/connect");
  return consentPage.searchParams.get("request")!;
}

/** Ada's Workspace with an Agent of hers, signed in. */
async function adaWithAgent() {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const agent = await (
    await cronk.request("POST", `/api/workspaces/${workspace.id}/agents`, { cookie, body: { name: "claude-max" } })
  ).json();
  return { workspace, cookie, agent };
}

/** The whole flow: register, ask, approve as the Agent, trade the code in. */
async function connectAs(cookie: string, agentId: string) {
  const { client_id } = await register();
  const { verifier, challenge } = pkce();
  const requestId = await requestConnection(client_id, challenge);
  const approved = await cronk.request("POST", `/api/oauth/requests/${requestId}/approve`, { cookie, body: { agentId } });
  expect(approved.status).toBe(200);
  const code = new URL((await approved.json()).redirectTo).searchParams.get("code")!;
  const response = await token({ grant_type: "authorization_code", client_id, code, code_verifier: verifier, redirect_uri: callback });
  expect(response.status).toBe(200);
  return { client_id, ...((await response.json()) as { access_token: string; refresh_token: string; expires_in: number }) };
}

describe("the token", () => {
  test("acts as the Agent the User picked, and is refused once the Agent is removed", async () => {
    const { workspace, cookie, agent } = await adaWithAgent();
    const { client_id, access_token, refresh_token } = await connectAs(cookie, agent.id);
    const asAgent = { headers: { authorization: `Bearer ${access_token}` } };

    expect((await cronk.request("GET", `/api/workspaces/${workspace.id}/agents`, asAgent)).status).toBe(200);
    const refused = await cronk.request("GET", "/api/me", asAgent);
    expect(refused.status).toBe(403);
    expect((await refused.json()).error.message).toContain("claude-max is an Agent");

    expect((await cronk.request("DELETE", `/api/agents/${agent.id}`, { cookie })).status).toBe(204);

    expect((await cronk.request("GET", `/api/workspaces/${workspace.id}/agents`, asAgent)).status).toBe(401);
    const renewed = await token({ grant_type: "refresh_token", client_id, refresh_token });
    expect(renewed.status).toBe(400);
    expect(await renewed.json()).toEqual(expect.objectContaining({ error: "invalid_grant" }));
  });

  test("lasts an hour, and the refresh token renews it once", async () => {
    const { workspace, cookie, agent } = await adaWithAgent();
    const { client_id, access_token, refresh_token, expires_in } = await connectAs(cookie, agent.id);
    const asAgent = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });
    expect(expires_in).toBe(3600);

    cronk.clock.advance(hours(1));
    expect((await cronk.request("GET", `/api/workspaces/${workspace.id}/agents`, asAgent(access_token))).status).toBe(401);

    const renewed = await token({ grant_type: "refresh_token", client_id, refresh_token });
    expect(renewed.status).toBe(200);
    const next = await renewed.json();
    expect((await cronk.request("GET", `/api/workspaces/${workspace.id}/agents`, asAgent(next.access_token))).status).toBe(200);
    expect((await token({ grant_type: "refresh_token", client_id, refresh_token })).status).toBe(400);
    expect((await token({ grant_type: "refresh_token", client_id, refresh_token: next.refresh_token })).status).toBe(200);
  });

  test("is listed with the Agent's tokens, and revoking it disconnects the client", async () => {
    const { workspace, cookie, agent } = await adaWithAgent();
    const { client_id, access_token, refresh_token } = await connectAs(cookie, agent.id);
    const [listed] = await (await cronk.request("GET", `/api/agents/${agent.id}/tokens`, { cookie })).json();
    expect(listed).toEqual(expect.objectContaining({ name: "Claude", access: "full" }));

    await cronk.request("DELETE", `/api/agents/${agent.id}/tokens/${listed.id}`, { cookie });

    const asAgent = { headers: { authorization: `Bearer ${access_token}` } };
    expect((await cronk.request("GET", `/api/workspaces/${workspace.id}/agents`, asAgent)).status).toBe(401);
    expect((await token({ grant_type: "refresh_token", client_id, refresh_token })).status).toBe(400);
  });
});

describe("the consent screen", () => {
  test("names the client and offers only the User's own Agents, in each of their Workspaces", async () => {
    const { workspace, cookie, agent } = await adaWithAgent();
    const other = await (
      await cronk.request("POST", "/api/workspaces", { cookie, body: { name: "Friends" } })
    ).json();
    const friendsAgent = await (
      await cronk.request("POST", `/api/workspaces/${other.id}/agents`, { cookie, body: { name: "helper" } })
    ).json();
    const bob = await addMember(cronk, cookie, workspace.id, "bob@example.com");
    await cronk.request("POST", `/api/workspaces/${workspace.id}/agents`, { cookie: bob.cookie, body: { name: "bobs-agent" } });
    const { client_id } = await register();
    const requestId = await requestConnection(client_id, pkce().challenge);

    const response = await cronk.request("GET", `/api/oauth/requests/${requestId}`, { cookie });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      client: { id: client_id, name: "Claude" },
      redirectUri: callback,
      agents: [
        { id: agent.id, name: "claude-max", workspace: { id: workspace.id, name: "Ada's Workspace" } },
        { id: friendsAgent.id, name: "helper", workspace: { id: other.id, name: "Friends" } },
      ],
    });
  });

  test("needs a signed-in User, who may pick only an Agent of their own", async () => {
    const { workspace, cookie } = await adaWithAgent();
    const bob = await addMember(cronk, cookie, workspace.id, "bob@example.com");
    const bobsAgent = await (
      await cronk.request("POST", `/api/workspaces/${workspace.id}/agents`, { cookie: bob.cookie, body: { name: "bobs-agent" } })
    ).json();
    const { client_id } = await register();
    const requestId = await requestConnection(client_id, pkce().challenge);

    expect((await cronk.request("GET", `/api/oauth/requests/${requestId}`)).status).toBe(401);
    const approved = await cronk.request("POST", `/api/oauth/requests/${requestId}/approve`, {
      cookie,
      body: { agentId: bobsAgent.id },
    });
    expect(approved.status).toBe(403);
    expect((await approved.json()).error.code).toBe("not_owner");
  });

  test("sends the browser back with the code and the client's state, once", async () => {
    const { cookie, agent } = await adaWithAgent();
    const { client_id } = await register();
    const requestId = await requestConnection(client_id, pkce().challenge);

    const approved = await cronk.request("POST", `/api/oauth/requests/${requestId}/approve`, { cookie, body: { agentId: agent.id } });

    const back = new URL((await approved.json()).redirectTo);
    expect(back.searchParams.get("code")).toMatch(/^cronk_oauth_code_/);
    expect(back.searchParams.get("state")).toBe("xyz");
    expect(back.searchParams.get("iss")).toBe(cronk.url);
    const again = await cronk.request("POST", `/api/oauth/requests/${requestId}/approve`, { cookie, body: { agentId: agent.id } });
    expect(again.status).toBe(404);
  });

  test("denying sends the browser back told access was denied", async () => {
    const { cookie } = await adaWithAgent();
    const { client_id } = await register();
    const requestId = await requestConnection(client_id, pkce().challenge);

    const denied = await cronk.request("POST", `/api/oauth/requests/${requestId}/deny`, { cookie });

    const back = new URL((await denied.json()).redirectTo);
    expect(`${back.origin}${back.pathname}`).toBe(callback);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("state")).toBe("xyz");
  });

  test("a request left unanswered for 10 minutes expires", async () => {
    const { cookie } = await adaWithAgent();
    const { client_id } = await register();
    const requestId = await requestConnection(client_id, pkce().challenge);

    cronk.clock.advance(10 * 60 * 1000);

    expect((await cronk.request("GET", `/api/oauth/requests/${requestId}`, { cookie })).status).toBe(404);
  });
});

/** Approves a request as the Agent and returns the code the browser is sent back with. */
async function approve(cookie: string, requestId: string, agentId: string) {
  const approved = await cronk.request("POST", `/api/oauth/requests/${requestId}/approve`, { cookie, body: { agentId } });
  return new URL((await approved.json()).redirectTo).searchParams.get("code")!;
}

describe("trading the code in", () => {
  test("needs the PKCE verifier and the client the code was issued to", async () => {
    const { cookie, agent } = await adaWithAgent();
    const { client_id } = await register();
    const other = await register();
    const attempt = async (params: Record<string, string>) => {
      const { verifier, challenge } = pkce();
      const code = await approve(cookie, await requestConnection(client_id, challenge), agent.id);
      const response = await token({ grant_type: "authorization_code", client_id, code, code_verifier: verifier, redirect_uri: callback, ...params });
      return { status: response.status, body: await response.json() };
    };

    expect(await attempt({ code_verifier: pkce().verifier })).toEqual({ status: 400, body: expect.objectContaining({ error: "invalid_grant" }) });
    expect(await attempt({ code_verifier: "too-short" })).toEqual({ status: 400, body: expect.objectContaining({ error: "invalid_request" }) });
    expect((await attempt({ client_id: other.client_id })).status).toBe(400);
    expect((await attempt({ redirect_uri: "https://claude.ai/elsewhere" })).status).toBe(400);
    expect((await attempt({ resource: "https://example.com/mcp" })).status).toBe(400);
    expect((await attempt({ resource: `${cronk.url}/mcp/` })).status).toBe(200);
    const traded = await attempt({});
    expect(traded).toEqual({
      status: 200,
      body: expect.objectContaining({ token_type: "Bearer", access_token: expect.stringMatching(/^cronk_agent_/) }),
    });
  });

  test("a code works once, and a wrong attempt uses it up", async () => {
    const { cookie, agent } = await adaWithAgent();
    const { client_id } = await register();
    const { verifier, challenge } = pkce();
    const code = await approve(cookie, await requestConnection(client_id, challenge), agent.id);
    const trade = (code_verifier: string) => token({ grant_type: "authorization_code", client_id, code, code_verifier });

    expect((await trade(pkce().verifier)).status).toBe(400);
    expect((await trade(verifier)).status).toBe(400);

    const second = pkce();
    const another = await approve(cookie, await requestConnection(client_id, second.challenge), agent.id);
    const once = () => token({ grant_type: "authorization_code", client_id, code: another, code_verifier: second.verifier });
    expect((await once()).status).toBe(200);
    expect((await once()).status).toBe(400);
  });

  test("a code not traded in within 10 minutes expires", async () => {
    const { cookie, agent } = await adaWithAgent();
    const { client_id } = await register();
    const { verifier, challenge } = pkce();
    const code = await approve(cookie, await requestConnection(client_id, challenge), agent.id);

    cronk.clock.advance(10 * 60 * 1000);

    const traded = await token({ grant_type: "authorization_code", client_id, code, code_verifier: verifier });
    expect(traded.status).toBe(400);
  });

  test("an Agent removed after the User picked it gets no token", async () => {
    const { cookie, agent } = await adaWithAgent();
    const { client_id } = await register();
    const { verifier, challenge } = pkce();
    const code = await approve(cookie, await requestConnection(client_id, challenge), agent.id);
    await cronk.request("DELETE", `/api/agents/${agent.id}`, { cookie });

    const traded = await token({ grant_type: "authorization_code", client_id, code, code_verifier: verifier });

    expect(traded.status).toBe(400);
    expect(await traded.json()).toEqual(expect.objectContaining({ error: "invalid_grant" }));
  });
});

describe("asking for an authorization", () => {
  test("from an unknown client, or with a redirect URI it didn't register, shows the error instead of sending the browser on", async () => {
    const { client_id } = await register();
    const ask = (params: Record<string, string>) =>
      authorize({ client_id, redirect_uri: callback, response_type: "code", code_challenge: "c", code_challenge_method: "S256", ...params });

    const unknown = await ask({ client_id: "cronk_client_nonsense" });
    expect(`${unknown.pathname}${unknown.search}`).toBe("/connect?error=invalid_client");
    const elsewhere = await ask({ redirect_uri: "https://evil.example.com/callback" });
    expect(`${elsewhere.pathname}${elsewhere.search}`).toBe("/connect?error=invalid_request");
  });

  test("without PKCE, or for another resource, sends the browser back with the error", async () => {
    const { client_id } = await register();
    const ask = (params: Record<string, string>) =>
      authorize({ client_id, redirect_uri: callback, response_type: "code", state: "xyz", ...params });

    const noPkce = await ask({});
    expect(`${noPkce.origin}${noPkce.pathname}`).toBe(callback);
    expect(noPkce.searchParams.get("error")).toBe("invalid_request");
    expect(noPkce.searchParams.get("state")).toBe("xyz");
    const plain = await ask({ code_challenge: "c", code_challenge_method: "plain" });
    expect(plain.searchParams.get("error")).toBe("invalid_request");
    const otherResource = await ask({ code_challenge: "c", code_challenge_method: "S256", resource: "https://example.com/mcp" });
    expect(otherResource.searchParams.get("error")).toBe("invalid_target");
    const implicit = await ask({ response_type: "token", code_challenge: "c", code_challenge_method: "S256" });
    expect(implicit.searchParams.get("error")).toBe("unsupported_response_type");
  });
});

describe("registering a client", () => {
  test("makes it a public client using codes with PKCE, whatever it asked for", async () => {
    const response = await cronk.request("POST", "/oauth/register", {
      body: { client_name: "Claude", redirect_uris: [callback], token_endpoint_auth_method: "client_secret_basic" },
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      client_id: expect.stringMatching(/^cronk_client_/),
      client_id_issued_at: expect.any(Number),
      client_name: "Claude",
      redirect_uris: [callback],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  });

  test("refuses redirect URIs that aren't https, except to localhost", async () => {
    for (const redirect_uris of [[], ["http://claude.ai/callback"], ["https://claude.ai/callback#x"], ["javascript:alert(1)"]]) {
      const response = await cronk.request("POST", "/oauth/register", { body: { redirect_uris } });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(expect.objectContaining({ error: "invalid_redirect_uri" }));
    }
    expect((await cronk.request("POST", "/oauth/register", { body: { redirect_uris: ["http://localhost:8080/cb"] } })).status).toBe(201);
  });
});

describe("a Client ID Metadata Document", () => {
  /** A stand-in for where a client publishes its metadata document; returns the document's URL. */
  async function publish(document: (url: string) => object) {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(document(`http://127.0.0.1:${(server.address() as AddressInfo).port}${request.url}`)));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/client.json`;
  }

  test("names the client on the consent screen", async () => {
    const { cookie } = await adaWithAgent();
    const url = await publish((self) => ({ client_id: self, client_name: "Claude", redirect_uris: [callback] }));

    const requestId = await requestConnection(url, pkce().challenge);

    const { client } = await (await cronk.request("GET", `/api/oauth/requests/${requestId}`, { cookie })).json();
    expect(client).toEqual({ id: url, name: "Claude" });
  });

  test("is refused when it names a different client id, isn't there, or asks to authenticate with a secret", async () => {
    const lying = await publish(() => ({ client_id: "https://claude.ai/client.json", redirect_uris: [callback] }));
    const ask = (client_id: string) =>
      authorize({ client_id, redirect_uri: callback, response_type: "code", code_challenge: "c", code_challenge_method: "S256" });

    expect((await ask(lying)).search).toBe("?error=invalid_client");
    expect((await ask(`${cronk.url}/nothing-here.json`)).search).toBe("?error=invalid_client");
    const withSecret = await publish((self) => ({
      client_id: self,
      redirect_uris: [callback],
      token_endpoint_auth_method: "client_secret_basic",
    }));
    expect((await ask(withSecret)).search).toBe("?error=invalid_client_metadata");
  });
});
