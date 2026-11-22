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
  // A few sentinel routes, one per area, show the routes reach the document;
  // the whole list would only repeat the routes themselves.
  expect(Object.keys(document.paths)).toEqual(
    expect.arrayContaining([
      "/api/agent",
      "/api/tickets/{ticketId}",
      "/api/decisions/{decisionId}",
      "/api/artifacts/{artifactId}/file",
      "/api/runners",
    ]),
  );
  for (const [path, operations] of Object.entries(document.paths as Record<string, Record<string, { responses?: unknown }>>)) {
    expect(path, path).toMatch(/^\/api\//);
    for (const [method, operation] of Object.entries(operations)) {
      expect(["get", "put", "post", "delete", "patch"], `${method} ${path}`).toContain(method);
      expect(operation.responses, `${method} ${path}`).toBeDefined();
    }
  }
  expect(document.components.securitySchemes.agentToken).toEqual(expect.objectContaining({ type: "http", scheme: "bearer" }));
  expect(Object.keys(document.paths["/api/sign-in"]).sort()).toEqual(["delete", "post"]);
  expect(document.paths["/api/setup"].post.requestBody.content["application/json"].schema.required).toEqual(
    expect.arrayContaining(["setupCode", "email", "password", "workspaceName"]),
  );

  const page = await cronk.request("GET", "/api/docs/");
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toContain("text/html");
});
