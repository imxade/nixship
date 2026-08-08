import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const defaultDataDir = path.join(os.homedir(), ".local", "share", "nix-platform");

export const paths = {
  data: path.resolve(/*turbopackIgnore: true*/ process.env.PLATFORM_DATA_DIR || defaultDataDir),
  get database() {
    return path.join(this.data, "platform.sqlite");
  },
  get repositories() {
    return path.join(this.data, "repositories");
  },
  get releases() {
    return path.join(this.data, "releases");
  },
  get appData() {
    return path.join(this.data, "applications");
  },
  get logs() {
    return path.join(this.data, "logs");
  },
  get runtime() {
    return path.join(this.data, "runtime");
  },
  get secrets() {
    return path.join(this.data, "secrets");
  },
  get backups() {
    return path.join(this.data, "backups");
  },
  get keyFile() {
    return path.join(this.secrets, "master.key");
  },
  get setupTokenFile() {
    return path.join(this.data, "setup-token.txt");
  },
};

export function ensureDataDirectories(): void {
  for (const directory of [
    paths.data,
    paths.repositories,
    paths.releases,
    paths.appData,
    paths.logs,
    paths.runtime,
    paths.secrets,
    paths.backups,
  ]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
}

export function appPaths(appId: string, deploymentId?: string) {
  const base = path.join(paths.appData, appId);
  const result = {
    base,
    data: path.join(base, "data"),
    cache: path.join(base, "cache"),
    logs: path.join(paths.logs, appId),
    repository: path.join(paths.repositories, appId),
    release: deploymentId ? path.join(paths.releases, appId, deploymentId) : undefined,
  };
  for (const directory of [
    result.base,
    result.data,
    result.cache,
    result.logs,
    result.repository,
  ]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  if (result.release) fs.mkdirSync(result.release, { recursive: true, mode: 0o700 });
  return result;
}
