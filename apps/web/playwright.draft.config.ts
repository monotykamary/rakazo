import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Actual transcript and RPC transport, with offline responses intercepted by Chromium.
export default defineConfig(base, {
  testMatch: "outgoing-draft.spec.ts",
  use: { baseURL: "http://127.0.0.1:5181", headless: true },
  webServer: {
    command: "./node_modules/.bin/vite --host 127.0.0.1 --port 5181",
    url: "http://127.0.0.1:5181",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
