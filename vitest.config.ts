import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The imported UI tests use Vitest mocks and need a browser DOM. Keep them
// isolated from Bun's protocol/runtime tests and from reference checkouts.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    include: ["src/features/source-control/ui/**/*.test.ts", "src/features/source-control/ui/**/*.test.tsx"],
    environment: "happy-dom",
  },
});
