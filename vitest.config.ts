import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    env: {
      DATABASE_URL: "postgresql://test:test@localhost/test",
      SPOTIFY_CLIENT_ID: "test-client-id",
      SPOTIFY_CLIENT_SECRET: "test-client-secret",
      SPOTIFY_MARKET: "DK",
      RESEND_API_KEY: "test-resend-key",
      ALERT_EMAIL_TO: "test@example.com",
      ALERT_EMAIL_FROM: "from@example.com",
      CRON_SECRET: "test-cron-secret-long-enough-here",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
});
