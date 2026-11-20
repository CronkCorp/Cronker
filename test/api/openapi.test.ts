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
    "/api/artifacts/{artifactId}",
    "/api/artifacts/{artifactId}/file",
    "/api/attachments/{attachmentId}",
    "/api/attachments/{attachmentId}/content",
    "/api/comments/{commentId}/attachments",
    "/api/decisions/{decisionId}",
    "/api/decisions/{decisionId}/versions",
    "/api/decisions/{decisionId}/versions/compare",
    "/api/decisions/{decisionId}/versions/{number}",
    "/api/documents/{documentId}",
    "/api/documents/{documentId}/attachments",
    "/api/documents/{documentId}/versions",
    "/api/documents/{documentId}/versions/compare",
    "/api/documents/{documentId}/versions/{number}",
    "/api/github/app",
    "/api/github/app/checklist",
    "/api/github/app/created",
    "/api/github/app/manifest",
    "/api/github/callback",
    "/api/github/installations",
    "/api/github/sign-in",
    "/api/github/webhooks",
    "/api/links/lookup",
    "/api/links/use",
    "/api/me",
    "/api/me/password",
    "/api/oauth/requests/{requestId}",
    "/api/oauth/requests/{requestId}/approve",
    "/api/oauth/requests/{requestId}/deny",
    "/api/projects/{projectId}",
    "/api/projects/{projectId}/artifacts",
    "/api/projects/{projectId}/decisions",
    "/api/projects/{projectId}/documents",
    "/api/projects/{projectId}/export",
    "/api/projects/{projectId}/export.zip",
    "/api/projects/{projectId}/glossary",
    "/api/projects/{projectId}/repositories",
    "/api/projects/{projectId}/repositories/{repositoryId}",
    "/api/projects/{projectId}/statuses",
    "/api/projects/{projectId}/statuses/{statusId}",
    "/api/projects/{projectId}/statuses/{statusId}/step",
    "/api/projects/{projectId}/terms",
    "/api/projects/{projectId}/tickets",
    "/api/questions/{questionId}/dismiss",
    "/api/runners",
    "/api/runners/events",
    "/api/runners/{runnerId}",
    "/api/runners/{runnerId}/triggers",
    "/api/runners/{runnerId}/triggers/{triggerId}",
    "/api/runs/{runId}",
    "/api/runs/{runId}/brief",
    "/api/runs/{runId}/finish",
    "/api/setup",
    "/api/sign-in",
    "/api/terms/{termId}",
    "/api/terms/{termId}/versions",
    "/api/terms/{termId}/versions/compare",
    "/api/terms/{termId}/versions/{number}",
    "/api/tickets/{ticketId}",
    "/api/tickets/{ticketId}/accept",
    "/api/tickets/{ticketId}/attachments",
    "/api/tickets/{ticketId}/brief",
    "/api/tickets/{ticketId}/comments",
    "/api/tickets/{ticketId}/completion",
    "/api/tickets/{ticketId}/dismiss",
    "/api/tickets/{ticketId}/documents",
    "/api/tickets/{ticketId}/documents/{documentId}",
    "/api/tickets/{ticketId}/pull-requests",
    "/api/tickets/{ticketId}/relations",
    "/api/tickets/{ticketId}/relations/{relationId}",
    "/api/tickets/{ticketId}/reopen",
    "/api/tickets/{ticketId}/reports",
    "/api/tickets/{ticketId}/retry",
    "/api/tickets/{ticketId}/runs",
    "/api/tickets/{ticketId}/timeline",
    "/api/transcripts/sessions/{sessionId}",
    "/api/transcripts/{transcriptId}",
    "/api/transcripts/{transcriptId}/entries",
    "/api/workspaces",
    "/api/workspaces/{workspaceId}",
    "/api/workspaces/{workspaceId}/agents",
    "/api/workspaces/{workspaceId}/artifacts",
    "/api/workspaces/{workspaceId}/decisions",
    "/api/workspaces/{workspaceId}/documents",
    "/api/workspaces/{workspaceId}/events",
    "/api/workspaces/{workspaceId}/export",
    "/api/workspaces/{workspaceId}/export.zip",
    "/api/workspaces/{workspaceId}/inbox",
    "/api/workspaces/{workspaceId}/members",
    "/api/workspaces/{workspaceId}/members/github",
    "/api/workspaces/{workspaceId}/members/{userId}",
    "/api/workspaces/{workspaceId}/members/{userId}/reset-link",
    "/api/workspaces/{workspaceId}/pending-adds",
    "/api/workspaces/{workspaceId}/pending-adds/{userId}",
    "/api/workspaces/{workspaceId}/projects",
    "/api/workspaces/{workspaceId}/search",
    "/api/workspaces/{workspaceId}/settings",
    "/api/workspaces/{workspaceId}/terms",
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
