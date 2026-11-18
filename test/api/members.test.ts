import { afterEach, beforeEach, expect, test } from "vitest";
import { setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

let cronk: StartedCronk;
beforeEach(async () => {
  cronk = await startCronk();
});
afterEach(async () => {
  await cronk?.stop();
});

test("a Workspace's members are listed, so a Ticket's Assignee can be picked", async () => {
  const { user, workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);

  const response = await cronk.request("GET", `/api/workspaces/${workspace.id}/members`, { cookie });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual([{ id: user.id, name: "ada@example.com", isAdmin: true }]);
});

test("members of a Workspace the User doesn't belong to answer 404", async () => {
  await setUp(cronk);
  const cookie = await signIn(cronk);
  const response = await cronk.request("GET", "/api/workspaces/00000000-0000-4000-8000-000000000000/members", {
    cookie,
  });
  expect(response.status).toBe(404);
});
