import { HttpError } from "./errors.ts";

const MAX_ENVIRONMENT_ENTRIES = 200;

export const APPLICATION_RUNTIME_ENVIRONMENT_KEYS = [
  "MANAGED_DEPLOYMENT",
  "APP_ID",
  "APP_NAME",
  "DEPLOYMENT_ID",
  "RELEASE_DIR",
  "DATA_DIR",
  "CACHE_DIR",
  "LOG_DIR",
  "HOST",
  "PORT",
] as const;

const applicationRuntimeEnvironmentKeys = new Set<string>(APPLICATION_RUNTIME_ENVIRONMENT_KEYS);

export function isReservedApplicationEnvironmentKey(key: string): boolean {
  const normalized = key.toUpperCase();
  return normalized.startsWith("PLATFORM_") || applicationRuntimeEnvironmentKeys.has(normalized);
}

export function parseEnvironmentText(text: string): Record<string, string> {
  const variables: Record<string, string> = {};
  const seen = new Set<string>();
  const lines = text.replace(/\r\n?/g, "\n").split("\n");

  for (let index = 0; index < lines.length; index++) {
    const original = lines[index] ?? "";
    let line = original.trimStart();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trimStart();

    const separator = line.indexOf("=");
    if (separator <= 0) {
      throw new HttpError(
        400,
        `Environment line ${index + 1} must use KEY=value`,
        "invalid_environment_text",
      );
    }
    const key = line.slice(0, separator).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) {
      throw new HttpError(
        400,
        `Environment line ${index + 1} has an invalid variable name`,
        "invalid_env_key",
      );
    }
    if (seen.has(key)) {
      throw new HttpError(
        400,
        `Environment variable ${key} appears more than once`,
        "duplicate_env_key",
      );
    }
    seen.add(key);

    const parsed = parseValue(lines, index, line.slice(separator + 1).trimStart());
    variables[key] = parsed.value;
    index = parsed.lastLineIndex;
    if (seen.size > MAX_ENVIRONMENT_ENTRIES) {
      throw new HttpError(
        400,
        `A maximum of ${MAX_ENVIRONMENT_ENTRIES} environment variables can be updated at once`,
        "too_many_env_keys",
      );
    }
  }

  if (seen.size === 0) {
    throw new HttpError(400, "Enter at least one KEY=value line", "empty_environment_text");
  }
  return variables;
}

function parseValue(
  lines: string[],
  firstLineIndex: number,
  rawValue: string,
): { value: string; lastLineIndex: number } {
  const quote = rawValue[0];
  if (quote !== '"' && quote !== "'") {
    const comment = rawValue.indexOf("#");
    const value = comment === -1 ? rawValue : rawValue.slice(0, comment);
    return { value: value.trim(), lastLineIndex: firstLineIndex };
  }

  let value = rawValue;
  let lineIndex = firstLineIndex;
  let closingQuote = findClosingQuote(value, quote);
  while (closingQuote === -1 && lineIndex + 1 < lines.length) {
    lineIndex += 1;
    value += `\n${lines[lineIndex] ?? ""}`;
    closingQuote = findClosingQuote(value, quote);
  }
  if (closingQuote === -1) {
    throw new HttpError(
      400,
      `Environment line ${firstLineIndex + 1} has an unterminated quoted value`,
      "invalid_environment_text",
    );
  }

  const trailing = value.slice(closingQuote + 1).trim();
  if (trailing && !trailing.startsWith("#")) {
    throw new HttpError(
      400,
      `Environment line ${lineIndex + 1} has unexpected text after a quoted value`,
      "invalid_environment_text",
    );
  }
  const inner = value.slice(1, closingQuote);
  if (quote === "'") return { value: inner, lastLineIndex: lineIndex };
  return {
    value: inner.replace(/\\([\\"nrt])/g, (_, escaped: string) => {
      if (escaped === "n") return "\n";
      if (escaped === "r") return "\r";
      if (escaped === "t") return "\t";
      return escaped;
    }),
    lastLineIndex: lineIndex,
  };
}

function findClosingQuote(value: string, quote: '"' | "'"): number {
  for (let index = 1; index < value.length; index++) {
    if (value[index] !== quote) continue;
    if (quote === "'" || precedingBackslashCount(value, index) % 2 === 0) return index;
  }
  return -1;
}

function precedingBackslashCount(value: string, index: number): number {
  let count = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor--) count += 1;
  return count;
}
