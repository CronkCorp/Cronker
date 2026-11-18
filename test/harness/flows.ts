import { expect } from "vitest";
import type { StartedCronk } from "./start-cronk.js";

/** Common paths through the API, for tests whose subject comes after them. */

export const firstUser = {
  email: "ada@example.com",
  password: "correct horse battery",
  workspaceName: "Ada's Workspace",
};

export async function setUp(cronk: StartedCronk) {
  const response = await cronk.request("POST", "/api/setup", { body: { ...firstUser, setupCode: cronk.setupCode() } });
  expect(response.status).toBe(201);
  return (await response.json()) as { user: { id: string; email: string }; workspace: { id: string; name: string } };
}

/** Signs in and returns the `Cookie` header value to send with later requests. */
export async function signIn(cronk: StartedCronk, email = firstUser.email, password = firstUser.password) {
  const response = await cronk.request("POST", "/api/sign-in", { body: { email, password } });
  expect(response.status).toBe(200);
  const setCookie = response.headers.get("set-cookie") ?? "";
  return setCookie.split(";")[0]!;
}

/**
 * An Admin adds someone by email and they join through the link, as a new User.
 * Returns the new member and the `Cookie` header of their sign-in.
 */
export async function addMember(cronk: StartedCronk, adminCookie: string, workspaceId: string, email: string) {
  const password = `${email}'s password`;
  const added = await cronk.request("POST", `/api/workspaces/${workspaceId}/members`, {
    cookie: adminCookie,
    body: { email },
  });
  expect(added.status).toBe(201);
  const { user, link } = (await added.json()) as { user: { id: string; email: string }; link: { url: string } };
  const used = await cronk.request("POST", "/api/links/use", { body: { token: new URL(link.url).hash.slice(1), password } });
  expect(used.status).toBe(200);
  return { user, password, cookie: await signIn(cronk, email, password) };
}
