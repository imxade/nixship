import { config } from "./config.ts";

const levels = { debug: 10, info: 20, warn: 30, error: 40 } as const;
const threshold = levels[config.LOG_LEVEL];

type Context = Record<string, unknown>;

function write(level: keyof typeof levels, message: string, context: Context = {}): void {
  if (levels[level] < threshold) return;
  const entry = JSON.stringify({
    time: new Date().toISOString(),
    level,
    message,
    ...context,
  });
  if (level === "error") console.error(entry);
  else if (level === "warn") console.warn(entry);
  else console.log(entry);
}

export const logger = {
  debug: (message: string, context?: Context) => write("debug", message, context),
  info: (message: string, context?: Context) => write("info", message, context),
  warn: (message: string, context?: Context) => write("warn", message, context),
  error: (message: string, context?: Context) => write("error", message, context),
  banner: (label: string, url: string) => {
    console.log(
      [
        "",
        "╭─ NIX SHIP ──────────────────────────────────────────────────────",
        `│ ${label}`,
        `│ ${url}`,
        "╰─────────────────────────────────────────────────────────────────",
        "",
      ].join("\n"),
    );
  },
};
