import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5175, strictPort: true },
  build: { sourcemap: false, target: "es2022" },
  define: { __SERVER__: JSON.stringify(process.env.TS_SERVER ?? "https://techsupport.westwardconsulting.ai") },
});
