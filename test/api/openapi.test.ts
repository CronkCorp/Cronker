import { afterEach, beforeEach, expect, test } from "vitest";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

let cronk: StartedCronk;
beforeEach(async () => {
  cronk = await startCronk();
});
afterEach(async () => {
  await cronk?.stop();
});

test("OpenAPI documentation is generated from the routes and served", async () => {
  const response = await cronk.request("GET", "/api/openapi.json");
  expect(response.status).toBe(200);
  const document = await response.json();

  expect(document.openapi).toMatch(/^3\./);
  expect(document.servers).toEqual([{ url: cronk.url }]);
  expect(Object.keys(document.paths).sort()).toEqual([
    "/api/links/lookup",
    "/api/links/use",
    "/api/me",
    "/api/me/password",
    "/api/setup",
    "/api/sign-in",
    "/api/workspaces",
    "/api/workspaces/{workspaceId}",
    "/api/workspaces/{workspaceId}/members",
    "/api/workspaces/{workspaceId}/members/{userId}",
    "/api/workspaces/{workspaceId}/members/{userId}/reset-link",
  ]);
  expect(Object.keys(document.paths["/api/sign-in"]).sort()).toEqual(["delete", "post"]);
  expect(document.paths["/api/setup"].post.requestBody.content["application/json"].schema.required).toEqual(
    expect.arrayContaining(["setupCode", "email", "password", "workspaceName"]),
  );

  const page = await cronk.request("GET", "/api/docs/");
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toContain("text/html");
});
