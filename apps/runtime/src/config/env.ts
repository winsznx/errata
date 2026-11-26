import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { z } from "zod";

loadDotenv({ path: resolve(process.cwd(), ".env"), quiet: true });
loadDotenv({ path: resolve(process.cwd(), "../../.env"), quiet: true });

const intFromEnv = (fallback: number) => z.coerce.number().int().positive().default(fallback);
const boolFromEnv = (fallback: boolean) =>
  z
    .enum(["true", "false", "1", "0"])
    .default(fallback ? "true" : "false")
    .transform((v) => v === "true" || v === "1");

const ENV_SCHEMA = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url().default("postgres://errata:errata@localhost:54329/errata"),
  APP_BASE_URL: z.string().url().default("http://localhost:3000"),
  RUNTIME_PORT: intFromEnv(4000),
  RUNTIME_HOST: z.string().default("127.0.0.1"),
  SESSION_SECRET: z.string().min(32).default("development-only-session-secret-change-me-0000"),
  INTERNAL_API_TOKEN: z.string().min(24).default("development-only-internal-token-0000"),
  SEC_USER_AGENT: z.string().min(8).default("Errata local development contact@errata.invalid"),
  SEC_REQUESTS_PER_SECOND: z.coerce.number().positive().max(10).default(2),
  SEC_POLL_INTERVAL_SECONDS: z.coerce.number().int().min(300).default(900),
  SOURCE_CACHE_DIR: z.string().default("storage/sources"),
  EXPORT_STORAGE_DIR: z.string().default("storage/exports"),
  DATASETS_DIR: z.string().default("../../datasets"),
  MODEL_PROVIDER: z.enum(["anthropic", "openai", "google"]).default("anthropic"),
  MODEL_ID: z.string().default("claude-sonnet-5-5"),
  MODEL_MAX_OUTPUT_TOKENS: intFromEnv(4096),
  MODEL_CONCURRENCY_GLOBAL: intFromEnv(8),
  MODEL_CONCURRENCY_WORKSPACE: intFromEnv(4),
  MODEL_CALL_TIMEOUT_MS: intFromEnv(90_000),
  TASK_DEADLINE_MS: intFromEnv(240_000),
  MODEL_MAX_CALLS_PER_RUN: intFromEnv(400),
  MODEL_DAILY_BUDGET_CALLS: intFromEnv(4000),
  MAX_TOOL_CALLS_PER_LOOP: intFromEnv(20),
  DEMO_TTL_HOURS: intFromEnv(24),
  DEMO_SESSION_LIMIT_PER_HOUR: intFromEnv(30),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  ENABLE_LIVE_MONITOR: boolFromEnv(false),
  ENABLE_TEST_FAULTS: boolFromEnv(false),
  BUILD_COMMIT: z.string().default("local"),
});

export type Env = z.infer<typeof ENV_SCHEMA>;

function loadEnv(): Env {
  const parsed = ENV_SCHEMA.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === "production") {
    if (env.SESSION_SECRET.startsWith("development-only")) throw new Error("SESSION_SECRET must be set in production");
    if (env.INTERNAL_API_TOKEN.startsWith("development-only")) throw new Error("INTERNAL_API_TOKEN must be set in production");
    if (env.SEC_USER_AGENT.includes("errata.invalid")) throw new Error("SEC_USER_AGENT must declare a real contact in production");
  }
  return env;
}

export const ENV: Env = loadEnv();
