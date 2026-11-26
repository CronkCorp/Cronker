import { describe, expect, test } from "vitest";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deniedToolOf, permissionsOf, policiesOf, translateAllowlist } from "../../daemon/src/opencode.js";
import { claudeArguments, withRealPaths } from "../../daemon/src/program.js";
import type { ClaimedRun } from "../../daemon/src/api.js";
import { defaultAllowedTools, notForMachineModels } from "../../server/runs/allowlist.js";

/** Rules and what OpenCode gets of each: a shell rule, a web tool, nothing (Cronk's, always allowed) or left out. */
const table: [rule: string, translated: string | "webfetch" | "websearch" | "cronk" | "skipped"][] = [
  ["Bash(git:*)", "git *"],
  ["Bash(gh pr view:*)", "gh pr view *"],
  ["  Bash(npm:*)  ", "npm *"],
  ["Bash(npm test)", "npm test"],
  ["Bash(npm run test:unit)", "npm run test:unit"],
  ["Bash(git *)", "git *"],
  ["WebFetch", "webfetch"],
  ["WebSearch", "websearch"],
  ["mcp__cronk", "cronk"],
  ["mcp__cronk__finish", "cronk"],
  ["Edit", "skipped"],
  ["Read", "skipped"],
  ["Write(src/**)", "skipped"],
  ["WebFetch(domain:example.com)", "skipped"],
  ["mcp__github", "skipped"],
  ["mcp__cronkish", "skipped"],
  ["Bash", "skipped"],
  ["Bash()", "skipped"],
  ["Bash(:*)", "skipped"],
  ["Bash(*)", "skipped"],
  ["Bash(*:*)", "skipped"],
  ["Bash(rm -rf *:*)", "skipped"],
  ["Bash(git?:*)", "skipped"],
  ["Bash(npm *test)", "skipped"],
  ["Task", "skipped"],
];

describe("the Runner's allowlist, translated for OpenCode", () => {
  test.each(table)("%s", (rule, translated) => {
    const translation = translateAllowlist([rule]);
    expect(translation).toEqual({
      commands: ["webfetch", "websearch", "cronk", "skipped"].includes(translated) ? [] : [translated],
      webFetch: translated === "webfetch",
      webSearch: translated === "websearch",
      skipped: translated === "skipped" ? [rule.trim()] : [],
    });
  });

  test("leaves out the same rules Cronk lists on the Runner's card as not applying to Machine models", () => {
    const rules = table.map(([rule]) => rule);
    expect(notForMachineModels(rules)).toEqual(translateAllowlist(rules).skipped);
  });

  test("translates the default allowlist completely", () => {
    const translation = translateAllowlist(defaultAllowedTools);
    expect(translation.skipped).toEqual([]);
    expect(notForMachineModels(defaultAllowedTools)).toEqual([]);
    expect(translation.commands).toHaveLength(defaultAllowedTools.length - 1);
  });

  test("lists each rule once", () => {
    expect(translateAllowlist(["Bash(git:*)", "Bash(git:*)", "Edit", "Edit"])).toEqual({
      commands: ["git *"],
      webFetch: false,
      webSearch: false,
      skipped: ["Edit"],
    });
  });
});

describe("a tool call OpenCode denied", () => {
  const call = (tool: string, input: object, state: object) => ({
    type: "tool_use",
    sessionID: "ses_1",
    part: { type: "tool", tool, state: { input, ...state } },
  });
  const denied = (tool: string, input: object = {}) =>
    deniedToolOf(call(tool, input, { status: "error", error: "Permission denied: x" }));

  test("is named as a person reads it, as Claude Code's are", () => {
    expect(denied("shell", { command: " npm publish " })).toBe("Bash(npm publish)");
    expect(denied("bash", { command: "rm -rf build" })).toBe("Bash(rm -rf build)");
    expect(denied("webfetch", { url: "https://example.com" })).toBe("WebFetch");
    expect(denied("websearch", { query: "x" })).toBe("WebSearch");
    expect(denied("edit")).toBe("edit");
    expect(denied("write")).toBe("write");
    expect(denied("apply_patch")).toBe("patch");
    expect(
      deniedToolOf(
        call("patch", {}, { status: "error", error: "Permission edit needs approval, and nobody is present to give it" }),
      ),
    ).toBe("patch");
  });

  test("isn't any other call or event", () => {
    expect(deniedToolOf(call("shell", { command: "npm test" }, { status: "error", error: "Command failed" }))).toBeNull();
    expect(deniedToolOf(call("shell", { command: "git status" }, { status: "completed", output: "" }))).toBeNull();
    expect(deniedToolOf({ type: "step_start", part: {} })).toBeNull();
    expect(deniedToolOf({ type: "tool_use" })).toBeNull();
  });
});

describe("a Runner's allowed directories", () => {
  const claimed = (fields: Partial<ClaimedRun> = {}): ClaimedRun => ({
    runId: "run",
    ticketKey: "CRONK-1",
    brief: "Brief",
    modelId: "claude-haiku-5-5",
    token: "token",
    mcpUrl: "https://cronk.example/mcp",
    repositories: [],
    allowedTools: ["Bash(git:*)"],
    ...fields,
  });
  const allow = (action: string, resource = "*") => ({ action, resource, effect: "allow" });
  const deny = (action: string, resource = "*") => ({ action, resource, effect: "deny" });
  /** Which rule decides, OpenCode's way: the last one matching, `*` matching anything. */
  const decides = (rules: { action: string; resource: string; effect: string }[], action: string, resource: string) =>
    rules.findLast((rule) => {
      const pattern = new RegExp(`^${rule.resource.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`);
      return (rule.action === "*" || rule.action === action) && pattern.test(resource);
    })?.effect;

  test("are added to claude one --add-dir each, before the allowlist; none when the Runner lists none or a Cronk omits them", () => {
    const args = claudeArguments(claimed({ allowedDirectories: ["/tmp", "/var/cache/builds"] }), "/run/mcp.json");
    expect(args.slice(args.indexOf("--permission-mode"))).toEqual([
      "--permission-mode",
      "acceptEdits",
      "--add-dir",
      "/tmp",
      "--add-dir",
      "/var/cache/builds",
      "--allowedTools",
      "Bash(git:*)",
      "mcp__cronk",
    ]);
    expect(claudeArguments(claimed({ allowedDirectories: [] }), "/run/mcp.json")).not.toContain("--add-dir");
    expect(claudeArguments(claimed(), "/run/mcp.json")).not.toContain("--add-dir");
  });

  test("a read-only Step's Run gets them to read, its edits still disallowed", () => {
    const args = claudeArguments(claimed({ allowedDirectories: ["/tmp"], readOnly: true }), "/run/mcp.json");
    expect(args.slice(args.indexOf("--permission-mode"))).toEqual([
      "--permission-mode",
      "default",
      "--disallowedTools",
      "Edit",
      "Write",
      "MultiEdit",
      "NotebookEdit",
      "--add-dir",
      "/tmp",
      "--allowedTools",
      "Bash(git:*)",
      "mcp__cronk",
    ]);
  });

  test("come with their real paths, a missing one as written", async () => {
    const root = await mkdtemp(join(tmpdir(), "cronk-dirs-"));
    try {
      const real = await mkdtemp(join(root, "real-"));
      await symlink(real, join(root, "link"));
      const resolved = await realpath(real);
      expect(await withRealPaths([join(root, "link"), join(root, "missing")])).toEqual(
        [...new Set([join(root, "link"), resolved, join(root, "missing")])],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("are opened to OpenCode, while any other absolute path stays denied", () => {
    const permissions = permissionsOf(["Bash(git:*)"], false, ["/tmp"]);
    expect(permissions.slice(-4)).toEqual([
      allow("external_directory", "/tmp"),
      allow("external_directory", "/tmp/*"),
      allow("read", "/tmp/*"),
      allow("edit", "/tmp/*"),
    ]);
    expect(decides(permissions, "external_directory", "/tmp/out.txt")).toBe("allow");
    expect(decides(permissions, "edit", "/tmp/out.txt")).toBe("allow");
    expect(decides(permissions, "read", "/tmp/out.txt")).toBe("allow");
    expect(decides(permissions, "external_directory", "/etc/passwd")).toBe("deny");
    expect(decides(permissions, "read", "/etc/passwd")).toBe("deny");
    expect(decides(permissions, "edit", "/tmpfoo/out.txt")).toBe("deny");
    expect(permissionsOf(["Bash(git:*)"])).not.toContainEqual(allow("read", "/tmp/*"));

    const policies = policiesOf(["Bash(git:*)"], false, ["/tmp"]).filter((rule) => rule.action === "tool.use");
    const tools = policies.map((rule) => ({ ...rule, action: "tool", resource: rule.resource }));
    expect(decides(tools, "tool", "edit:/tmp/out.txt")).toBe("allow");
    expect(decides(tools, "tool", "external_directory:/tmp/out.txt")).toBe("allow");
    expect(decides(tools, "tool", "edit:/etc/passwd")).toBe("deny");
  });

  test("a read-only Step's Run on OpenCode may read them but edits stay denied, last", () => {
    const permissions = permissionsOf([], true, ["/tmp"]);
    expect(decides(permissions, "read", "/tmp/out.txt")).toBe("allow");
    expect(decides(permissions, "edit", "/tmp/out.txt")).toBe("deny");
    expect(permissions.at(-1)).toEqual(deny("patch"));
    const policies = policiesOf([], true, ["/tmp"]);
    expect(policies.at(-1)).toEqual(deny("tool.use", "patch:*"));
  });
});
