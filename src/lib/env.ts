import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url(),
  SPOTIFY_CLIENT_ID: z.string().min(1),
  SPOTIFY_CLIENT_SECRET: z.string().min(1),
  SPOTIFY_REDIRECT_URI: z
    .string()
    .url()
    .optional()
    .default("http://127.0.0.1:3000/api/spotify/callback"),
  SPOTIFY_MARKET: z.string().length(2).transform((value) => value.toUpperCase()),
  RESEND_API_KEY: z.string().min(1),
  ALERT_EMAIL_TO: z.string().email(),
  ALERT_EMAIL_FROM: z.string().email(),
  CRON_SECRET: z.string().min(24),
});

let cachedEnv: z.infer<typeof envSchema> | null = null;

export function getEnv() {
  if (cachedEnv) {
    return cachedEnv;
  }

  const parsedEnv = envSchema.safeParse(process.env);
  if (!parsedEnv.success) {
    const formatted = parsedEnv.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("\n");

    throw new Error(`Invalid environment variables:\n${formatted}`);
  }

  cachedEnv = parsedEnv.data;
  return cachedEnv;
}
