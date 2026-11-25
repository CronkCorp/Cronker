import { describe, expect, test } from "vitest";
import { deniedToolOf, translateAllowlist } from "../../daemon/src/opencode.js";
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
