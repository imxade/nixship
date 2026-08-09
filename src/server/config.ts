import { z } from "zod";

function envBoolean(defaultValue: boolean) {
  return z.preprocess((value) => {
    if (value === undefined || value === null || value === "") return defaultValue;
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["1", "true", "yes", "on"].includes(normalized)) return true;
      if (["0", "false", "no", "off"].includes(normalized)) return false;
    }
    return value;
  }, z.boolean());
}

const envSchema = z.object({
  HOSTNAME: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PLATFORM_PUBLIC_URL: z.string().url().optional().or(z.literal("")),
  BUILD_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  SOURCE_POLL_SECONDS: z.coerce.number().int().min(15).max(86400).default(60),
  CLOUDFLARED_BIN: z.string().trim().min(1).default("cloudflared"),
  QUICK_TUNNELS_ENABLED: envBoolean(true),
  QUICK_TUNNEL_RECONCILE_SECONDS: z.coerce.number().int().min(5).max(300).default(10),
  METRICS_INTERVAL_SECONDS: z.coerce.number().int().min(2).max(300).default(5),
  MIN_FREE_DISK_MB: z.coerce.number().int().min(128).default(1024),
  MIN_FREE_MEMORY_MB: z.coerce.number().int().min(64).default(256),
  RELEASE_RETENTION: z.coerce.number().int().min(1).max(100).default(5),
  LOG_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(7),
  LOG_MAX_MB: z.coerce.number().int().min(10).max(102400).default(1024),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export const config = envSchema.parse(process.env);
