// The web client takes the server's types with `import type` (CRONK-49). The build guard refuses a runtime import
// of a server module, which would pull server code into the browser bundle, and names the module.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { afterEach, expect, test } from "vitest";
import { noServerModules } from "../../vite.config.js";

const costs = join(import.meta.dirname, "../../server/runs/costs.ts");
const dirs: string[] = [];

afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** Builds a page whose script is `main`, as the web client's build does, without writing it. */
function buildPage(main: string) {
  const root = mkdtempSync(join(tmpdir(), "cronk-guard-"));
  dirs.push(root);
  writeFileSync(join(root, "index.html"), `<script type="module" src="./main.ts"></script>`);
  writeFileSync(join(root, "main.ts"), main);
  return build({ configFile: false, root, logLevel: "silent", plugins: [noServerModules()], build: { write: false } });
}

test("a type-only import of a server module builds", async () => {
  await expect(
    buildPage(`import type { Cost } from ${JSON.stringify(costs)};\nconst cost: Cost = { amount: 1, currency: "USD" };\nconsole.log(cost);\n`),
  ).resolves.toBeDefined();
});

test("a runtime import of a server module fails the build, naming the module", async () => {
  await expect(buildPage(`import { Cost } from ${JSON.stringify(costs)};\nconsole.log(Cost);\n`)).rejects.toThrow(
    /Server module reached the browser bundle: server\/runs\/costs\.ts/,
  );
});
