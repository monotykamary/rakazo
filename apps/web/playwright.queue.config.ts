import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Real UI and typed RPC transport; deterministic responses, no Docker or provider.
export default defineConfig(base, {
  testMatch: [
    "composer-queue.spec.ts",
    "queue-inspection.spec.ts",
    "queue-recovery.spec.ts",
    "model-routing.spec.ts",
  ],
  use: { baseURL: "http://127.0.0.1:5179" },
  webServer: {
    command: "./node_modules/.bin/vite --host 127.0.0.1 --port 5179",
    url: "http://127.0.0.1:5179",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
