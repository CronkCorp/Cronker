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
    "/api/agent",
    "/api/agents/{agentId}",
    "/api/agents/{agentId}/tokens",
    "/api/agents/{agentId}/tokens/{tokenId}",
    "/api/github/app",
    "/api/github/app/created",
    "/api/github/app/manifest",
    "/api/github/callback",
    "/api/github/sign-in",
    "/api/links/lookup",
    "/api/links/use",
    "/api/me",
    "/api/me/password",
    "/api/oauth/requests/{requestId}",
    "/api/oauth/requests/{requestId}/approve",
    "/api/oauth/requests/{requestId}/deny",
    "/api/projects/{projectId}",
    "/api/projects/{projectId}/statuses",
    "/api/projects/{projectId}/statuses/{statusId}",
    "/api/projects/{projectId}/statuses/{statusId}/step",
    "/api/projects/{projectId}/tickets",
    "/api/setup",
    "/api/sign-in",
    "/api/tickets/{ticketId}",
    "/api/tickets/{ticketId}/brief",
    "/api/tickets/{ticketId}/comments",
    "/api/tickets/{ticketId}/relations",
    "/api/tickets/{ticketId}/relations/{relationId}",
    "/api/tickets/{ticketId}/timeline",
    "/api/workspaces",
    "/api/workspaces/{workspaceId}",
    "/api/workspaces/{workspaceId}/agents",
    "/api/workspaces/{workspaceId}/events",
    "/api/workspaces/{workspaceId}/inbox",
    "/api/workspaces/{workspaceId}/members",
    "/api/workspaces/{workspaceId}/members/github",
    "/api/workspaces/{workspaceId}/members/{userId}",
    "/api/workspaces/{workspaceId}/members/{userId}/reset-link",
    "/api/workspaces/{workspaceId}/pending-adds",
    "/api/workspaces/{workspaceId}/pending-adds/{userId}",
    "/api/workspaces/{workspaceId}/projects",
    "/api/workspaces/{workspaceId}/tickets/{key}",
  ]);
  expect(document.components.securitySchemes.agentToken).toEqual(expect.objectContaining({ type: "http", scheme: "bearer" }));
  expect(Object.keys(document.paths["/api/sign-in"]).sort()).toEqual(["delete", "post"]);
  expect(document.paths["/api/setup"].post.requestBody.content["application/json"].schema.required).toEqual(
    expect.arrayContaining(["setupCode", "email", "password", "workspaceName"]),
  );

  const page = await cronk.request("GET", "/api/docs/");
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toContain("text/html");
});
