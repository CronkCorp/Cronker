import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development, run the server with CRONK_PUBLIC_URL=http://localhost:5173 so that
// requests through this proxy carry Cronk's own Origin.
export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: { proxy: { "/api": "http://localhost:3000" } },
});
