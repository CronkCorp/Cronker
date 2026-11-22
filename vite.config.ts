import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const repoDir = fileURLToPath(new URL("./", import.meta.url));
const serverDir = `${repoDir}server/`;

/**
 * Fails the build when a module under `server/` would reach the browser bundle. The web client takes the server's
 * types with `import type`, which leaves nothing behind; a runtime import, even of one value, would pull server code
 * (and its database driver) into the browser.
 */
export function noServerModules(): Plugin {
  return {
    name: "cronk:no-server-modules",
    enforce: "pre",
    load(id) {
      const path = id.split("?")[0]!;
      if (path.startsWith(serverDir)) {
        const importer = [...this.getModuleIds()].find((m) => this.getModuleInfo(m)?.importedIds.includes(id));
        this.error(
          `Server module reached the browser bundle: ${path.slice(repoDir.length)}` +
            (importer ? `, imported by ${importer.startsWith(repoDir) ? importer.slice(repoDir.length) : importer}` : "") +
            `. Import the server's types with \`import type\`.`,
        );
      }
      return null;
    },
  };
}

// In development, run the server with CRONK_PUBLIC_URL=http://localhost:5173 so that
// requests through this proxy carry Cronk's own Origin.
export default defineConfig({
  root: "web",
  plugins: [noServerModules(), react()],
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: { proxy: { "/api": "http://localhost:3000" } },
});
