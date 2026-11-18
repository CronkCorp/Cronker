import { createHash, randomBytes } from "node:crypto";
import { expect, test } from "./fixtures.js";

const callback = "https://claude.ai/api/mcp/auth_callback";

test("a User connects a claude.ai connector as one of their Agents on the consent screen", async ({ page, cronk }) => {
  const setup = await cronk.request("POST", "/api/setup", {
    body: {
      setupCode: cronk.setupCode(),
      email: "ada@example.com",
      password: "correct horse battery",
      workspaceName: "Ada's Workspace",
    },
  });
  const { workspace } = await setup.json();
  const signedIn = await cronk.request("POST", "/api/sign-in", {
    body: { email: "ada@example.com", password: "correct horse battery" },
  });
  const cookie = signedIn.headers.get("set-cookie")!.split(";")[0]!;
  for (const name of ["claude-max", "claude-api"]) {
    await cronk.request("POST", `/api/workspaces/${workspace.id}/agents`, { cookie, body: { name } });
  }

  // The connector registers itself and sends the browser to Cronk.
  const registered = await cronk.request("POST", "/oauth/register", {
    body: { client_name: "Claude", redirect_uris: [callback] },
  });
  const { client_id } = await registered.json();
  const verifier = randomBytes(32).toString("base64url");
  const authorize = new URL("/oauth/authorize", cronk.url);
  authorize.search = new URLSearchParams({
    client_id,
    redirect_uri: callback,
    response_type: "code",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: "xyz",
  }).toString();
  // claude.ai itself is never reached: its callback just records where the browser was sent.
  await page.route(`${callback}**`, (route) => route.fulfill({ body: "Back at claude.ai" }));

  await page.goto(authorize.href);
  await expect(page.getByText("Sign in to Cronk to choose which of your Agents the connector acts as.")).toBeVisible();
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("heading", { name: "Connect Claude to Cronk" })).toBeVisible();
  await expect(page.getByText("you go back to claude.ai")).toBeVisible();
  await page.getByRole("radio", { name: /claude-max/ }).check();
  await page.getByRole("button", { name: "Connect", exact: true }).click();

  await expect(page.getByText("Back at claude.ai")).toBeVisible();
  const back = new URL(page.url());
  expect(back.searchParams.get("state")).toBe("xyz");
  const traded = await fetch(`${cronk.url}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id, code: back.searchParams.get("code")!, code_verifier: verifier }),
  });
  const { access_token } = await traded.json();
  const asAgent = await cronk.request("GET", "/api/agent", { headers: { authorization: `Bearer ${access_token}` } });
  expect((await asAgent.json()).agent).toEqual(expect.objectContaining({ name: "claude-max" }));
});
