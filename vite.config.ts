import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
export default defineConfig({
  root: path.resolve(__dirname, "frontend"),
  plugins: [react()],
  publicDir: false,
  build: { outDir: path.resolve(__dirname, "public"), emptyOutDir: false, sourcemap: false },
  server: { host: "0.0.0.0", port: 5173 }
});