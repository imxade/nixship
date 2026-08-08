import crypto from "node:crypto";
import { promises as dns } from "node:dns";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import JSZip from "jszip";
import { z } from "zod";
import { audit } from "./audit.ts";
import { decryptSecret, encryptSecret } from "./crypto.ts";
import { getDb, nowIso } from "./db.ts";
import { HttpError } from "./errors.ts";
import { appPaths } from "./paths.ts";
import type { AppRow, IntegrationConnectionRow } from "./types.ts";

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 1024 * 1024 * 1024;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 20_000;

const snapshotSchema = z
  .object({
    revision: z.string().regex(/^[0-9a-f]{64}$/),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    archiveBytes: z.number().int().nonnegative().max(MAX_ARCHIVE_BYTES),
    createdAt: z.string().datetime(),
    source: z.enum(["repository.created", "repository.synced", "pull_request.merged"]),
    pullRequestNumber: z.number().int().positive().optional(),
  })
  .strict();

export const harburRepositorySchema = z
  .object({
    id: z.string().min(1).max(201),
    owner: z.string().min(1).max(100),
    name: z.string().min(1).max(100),
    description: z.string().nullable(),
    visibility: z.enum(["public", "private"]),
    defaultBranch: z.string().min(1).max(200),
    updatedAt: z.string().datetime(),
    latestSnapshot: snapshotSchema.nullable(),
  })
  .strict();

export type HarburRepository = z.infer<typeof harburRepositorySchema>;

const capabilitiesSchema = z
  .object({
    apiVersion: z.literal("v1"),
    authentication: z.object({ type: z.literal("bearer"), configured: z.boolean() }).strict(),
    snapshots: z
      .object({
        immutable: z.literal(true),
        revision: z.literal("sha256"),
        archive: z.literal("zip"),
      })
      .strict(),
    events: z.object({ delivery: z.literal("poll"), cursor: z.literal("integer") }).strict(),
  })
  .strict();

const repositoriesSchema = z.object({ repositories: z.array(harburRepositorySchema) }).strict();

export const harburEventPageSchema = z
  .object({
    events: z.array(
      z
        .object({
          cursor: z.number().int().positive(),
          id: z.string().min(1).max(500),
          type: z.literal("repository.snapshot"),
          repositoryId: z.string().min(1).max(201),
          revision: z.string().regex(/^[0-9a-f]{64}$/),
          createdAt: z.string().datetime(),
        })
        .strict(),
    ),
    nextCursor: z.number().int().nonnegative(),
    hasMore: z.boolean(),
  })
  .strict();

export type HarburEventPage = z.infer<typeof harburEventPageSchema>;

const connectSchema = z.object({
  baseUrl: z.string().trim().url().max(2048),
  token: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().min(32).max(512).optional(),
  ),
  allowPrivateNetwork: z.boolean().default(false),
});

export async function connectHarbur(
  raw: unknown,
  actor?: { id: string; ip?: string | null },
): Promise<ReturnType<typeof publicConnection>> {
  const input = connectSchema.parse(raw);
  const baseUrl = await normalizeHarburBaseUrl(input.baseUrl, input.allowPrivateNetwork);
  const candidate: IntegrationConnectionRow = {
    id: crypto.randomUUID(),
    provider: "harbur",
    base_url: baseUrl,
    token_encrypted: input.token ? encryptSecret(input.token) : null,
    allow_private_network: input.allowPrivateNetwork ? 1 : 0,
    event_cursor: 0,
    status: "connected",
    last_error: null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  const capabilities = await harburJson(candidate, "/api/integrations/v1/capabilities", {
    schema: capabilitiesSchema,
    authenticated: false,
  });
  if (input.token && !capabilities.authentication.configured) {
    throw new HttpError(
      400,
      "The Harbur instance has not enabled its deployment integration token",
      "harbur_integration_disabled",
    );
  }
  await listHarburRepositories(candidate);

  const existing = getDb()
    .prepare("SELECT * FROM integration_connections WHERE provider = 'harbur' AND base_url = ?")
    .get(baseUrl) as IntegrationConnectionRow | undefined;
  const id = existing?.id ?? candidate.id;
  const now = nowIso();
  getDb()
    .prepare(
      `INSERT INTO integration_connections(
        id, provider, base_url, token_encrypted, allow_private_network, event_cursor,
        status, last_error, created_at, updated_at
      ) VALUES (?, 'harbur', ?, ?, ?, 0, 'connected', NULL, ?, ?)
      ON CONFLICT(provider, base_url) DO UPDATE SET
        token_encrypted = excluded.token_encrypted,
        allow_private_network = excluded.allow_private_network,
        status = 'connected', last_error = NULL, updated_at = excluded.updated_at`,
    )
    .run(
      id,
      baseUrl,
      candidate.token_encrypted,
      candidate.allow_private_network,
      existing?.created_at ?? now,
      now,
    );
  audit({
    userId: actor?.id,
    ip: actor?.ip,
    action: "integration.connected",
    entityType: "integration_connection",
    entityId: id,
    details: { provider: "harbur", baseUrl, allowPrivateNetwork: input.allowPrivateNetwork },
  });
  return publicConnection(getHarburConnection(id));
}

export function listHarburConnections() {
  return (
    getDb()
      .prepare(
        "SELECT * FROM integration_connections WHERE provider = 'harbur' ORDER BY created_at",
      )
      .all() as IntegrationConnectionRow[]
  ).map(publicConnection);
}

export function getHarburConnection(id: string): IntegrationConnectionRow {
  const connection = getDb()
    .prepare("SELECT * FROM integration_connections WHERE id = ? AND provider = 'harbur'")
    .get(id) as IntegrationConnectionRow | undefined;
  if (!connection) throw new HttpError(404, "Harbur connection not found", "harbur_not_found");
  return connection;
}

export function disconnectHarbur(id: string, actor?: { id: string; ip?: string | null }): void {
  getHarburConnection(id);
  const inUse = getDb()
    .prepare("SELECT COUNT(*) AS count FROM applications WHERE source_connection_id = ?")
    .get(id) as { count: number };
  if (inUse.count > 0) {
    throw new HttpError(
      409,
      "Delete applications imported from this Harbur instance before disconnecting it",
      "harbur_connection_in_use",
    );
  }
  getDb().prepare("DELETE FROM integration_connections WHERE id = ?").run(id);
  audit({
    userId: actor?.id,
    ip: actor?.ip,
    action: "integration.disconnected",
    entityType: "integration_connection",
    entityId: id,
    details: { provider: "harbur" },
  });
}

export async function listHarburRepositories(
  connectionOrId: IntegrationConnectionRow | string,
): Promise<HarburRepository[]> {
  const connection =
    typeof connectionOrId === "string" ? getHarburConnection(connectionOrId) : connectionOrId;
  const result = await harburJson(connection, "/api/integrations/v1/repositories", {
    schema: repositoriesSchema,
    authenticated: Boolean(connection.token_encrypted),
  });
  return result.repositories;
}

export async function latestHarburRevision(app: AppRow) {
  if (!app.source_connection_id || !app.source_repository_id) {
    throw new Error("Harbur application source metadata is incomplete");
  }
  const repository = (await listHarburRepositories(app.source_connection_id)).find(
    (candidate) => candidate.id === app.source_repository_id,
  );
  if (!repository?.latestSnapshot) {
    throw new HttpError(
      409,
      "Harbur repository has no deployable snapshot",
      "harbur_snapshot_missing",
    );
  }
  return repository.latestSnapshot.revision;
}

export async function pollHarburEvents(connection: IntegrationConnectionRow) {
  const page = await harburJson(
    connection,
    `/api/integrations/v1/events?after=${connection.event_cursor}&limit=100`,
    { schema: harburEventPageSchema, authenticated: true },
  );
  return validateHarburEventPage(page, connection.event_cursor);
}

export function validateHarburEventPage(page: HarburEventPage, after: number) {
  let previous = after;
  for (const event of page.events) {
    if (event.cursor <= previous) {
      throw new HttpError(502, "Harbur event cursors are not strictly increasing", "harbur_cursor");
    }
    previous = event.cursor;
  }
  if (page.nextCursor !== previous) {
    throw new HttpError(502, "Harbur returned an inconsistent event cursor", "harbur_cursor");
  }
  return page;
}

export async function prepareHarburRelease(
  app: AppRow,
  deploymentId: string,
  requestedRevision?: string | null,
  signal?: AbortSignal,
): Promise<{ commit: string; releaseDir: string }> {
  const revision = z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .parse(requestedRevision);
  if (!app.source_connection_id || !app.source_repository_id) {
    throw new Error("Harbur application source metadata is incomplete");
  }
  const [owner, repositoryName, ...extra] = app.source_repository_id.split("/");
  if (!owner || !repositoryName || extra.length > 0) {
    throw new Error("Harbur repository identifier is invalid");
  }
  const connection = getHarburConnection(app.source_connection_id);
  const endpoint = `/api/integrations/v1/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(
    repositoryName,
  )}/snapshots/${revision}`;
  const response = await harburFetch(connection, endpoint, true, signal);
  if (!response.ok) await throwHarburResponse(response);
  const declaredDigest = response.headers.get("x-content-sha256")?.toLowerCase();
  if (declaredDigest !== revision) {
    throw new HttpError(502, "Harbur returned an unexpected snapshot digest", "harbur_digest");
  }
  const archive = await readBoundedResponse(response, MAX_ARCHIVE_BYTES);
  const actualDigest = crypto.createHash("sha256").update(archive).digest("hex");
  if (actualDigest !== revision) {
    throw new HttpError(502, "Harbur snapshot digest verification failed", "harbur_digest");
  }
  const locations = appPaths(app.id, deploymentId);
  if (!locations.release) throw new Error("Deployment release path was not created");
  await extractHarburArchive(archive, locations.release);
  return { commit: revision, releaseDir: locations.release };
}

export async function normalizeHarburBaseUrl(raw: string, allowPrivateNetwork: boolean) {
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash) {
    throw new HttpError(
      400,
      "Harbur URL must not contain credentials, query, or fragment",
      "harbur_url",
    );
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new HttpError(400, "Harbur URL must be the instance origin", "harbur_url");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new HttpError(400, "Harbur URL must use HTTPS", "harbur_url");
  }
  const addresses = await resolvedAddresses(url.hostname);
  const privateAddresses = addresses.filter(isPrivateIpAddress);
  if (!allowPrivateNetwork && privateAddresses.length > 0) {
    throw new HttpError(
      400,
      "Harbur URL resolves to a private network; enable private-network access explicitly",
      "harbur_private_network",
    );
  }
  if (
    url.protocol === "http:" &&
    (!allowPrivateNetwork || privateAddresses.length !== addresses.length)
  ) {
    throw new HttpError(
      400,
      "Unencrypted Harbur URLs are allowed only on private networks",
      "harbur_url",
    );
  }
  return url.origin;
}

export function isPrivateIpAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [first = 0, second = 0] = address.split(".").map(Number);
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 100 && second >= 64 && second <= 127) ||
      first >= 224
    );
  }
  if (!net.isIPv6(address)) return true;
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)?.[1];
  return mapped ? isPrivateIpAddress(mapped) : false;
}

async function harburJson<T>(
  connection: IntegrationConnectionRow,
  endpoint: string,
  options: { schema: z.ZodType<T>; authenticated: boolean },
): Promise<T> {
  const response = await harburFetch(connection, endpoint, options.authenticated);
  if (!response.ok) await throwHarburResponse(response);
  const bytes = await readBoundedResponse(response, MAX_JSON_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new HttpError(502, "Harbur returned invalid JSON", "harbur_invalid_response");
  }
  const validated = options.schema.safeParse(parsed);
  if (!validated.success) {
    throw new HttpError(502, "Harbur returned an invalid response", "harbur_invalid_response");
  }
  return validated.data;
}

async function harburFetch(
  connection: IntegrationConnectionRow,
  endpoint: string,
  authenticated: boolean,
  signal?: AbortSignal,
) {
  const base = new URL(connection.base_url);
  await normalizeHarburBaseUrl(connection.base_url, Boolean(connection.allow_private_network));
  const url = new URL(endpoint, `${base.origin}/`);
  if (url.origin !== base.origin) throw new Error("Harbur endpoint escaped its configured origin");
  const timeout = AbortSignal.timeout(60_000);
  const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const token =
    authenticated && connection.token_encrypted ? decryptSecret(connection.token_encrypted) : null;
  return fetch(url, {
    redirect: "error",
    signal: combinedSignal,
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
}

async function resolvedAddresses(hostname: string) {
  if (hostname.toLowerCase() === "localhost") return ["127.0.0.1"];
  if (net.isIP(hostname)) return [hostname];
  let records: Array<{ address: string }>;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new HttpError(400, "Harbur hostname could not be resolved", "harbur_dns");
  }
  if (records.length === 0) {
    throw new HttpError(400, "Harbur hostname returned no addresses", "harbur_dns");
  }
  return [...new Set(records.map((record) => record.address))];
}

async function readBoundedResponse(response: Response, maxBytes: number) {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(413, "Harbur response is too large", "harbur_response_too_large");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, "Harbur response is too large", "harbur_response_too_large");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

async function throwHarburResponse(response: Response): Promise<never> {
  const body = await readBoundedResponse(response, 64 * 1024).catch(() => Buffer.alloc(0));
  let message = `Harbur request failed (${response.status})`;
  try {
    const parsed = JSON.parse(body.toString("utf8")) as { error?: unknown };
    if (typeof parsed.error === "string") message = parsed.error;
  } catch {
    // The status remains useful when the remote body is not JSON.
  }
  throw new HttpError(response.status === 401 ? 401 : 502, message, "harbur_request_failed");
}

export async function extractHarburArchive(archive: Buffer, releaseDir: string) {
  const declaredSizes = validateZipCentralDirectory(archive);
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(archive, { checkCRC32: true, createFolders: false });
  } catch {
    throw new HttpError(400, "Harbur snapshot is not a valid ZIP archive", "harbur_archive");
  }
  const entries = Object.values(zip.files);
  if (entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new HttpError(400, "Harbur snapshot contains too many files", "harbur_archive");
  }
  for (const entry of entries) {
    validateArchivePath(entry.name, entry.unsafeOriginalName);
    const permissions = typeof entry.unixPermissions === "number" ? entry.unixPermissions : 0;
    const fileType = permissions & 0o170000;
    if (fileType !== 0 && fileType !== 0o100000 && fileType !== 0o040000) {
      throw new HttpError(400, "Harbur snapshot contains a non-regular file", "harbur_archive");
    }
    if (!declaredSizes.has(entry.name)) {
      throw new HttpError(400, "Harbur snapshot directory is inconsistent", "harbur_archive");
    }
  }

  const parent = path.dirname(releaseDir);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const staging = fs.mkdtempSync(path.join(parent, ".harbur-release-"));
  try {
    let actualTotal = 0;
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const destination = path.join(staging, entry.name);
      const relative = path.relative(staging, destination);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new HttpError(400, "Harbur snapshot path escaped extraction", "harbur_archive");
      }
      if (entry.dir) {
        fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
        continue;
      }
      const bytes = Buffer.from(await entry.async("uint8array"));
      if (bytes.length !== declaredSizes.get(entry.name)) {
        throw new HttpError(400, "Harbur snapshot file size verification failed", "harbur_archive");
      }
      actualTotal += bytes.length;
      if (bytes.length > MAX_FILE_BYTES || actualTotal > MAX_EXTRACTED_BYTES) {
        throw new HttpError(
          400,
          "Harbur snapshot expands beyond the allowed size",
          "harbur_archive",
        );
      }
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      fs.writeFileSync(destination, bytes, { flag: "wx", mode: 0o600 });
    }
    if (!fs.existsSync(path.join(staging, "flake.nix"))) {
      throw new HttpError(400, "Harbur snapshot does not contain flake.nix", "flake_missing");
    }
    if (!fs.existsSync(path.join(staging, "flake.lock"))) {
      throw new HttpError(400, "Harbur snapshot does not contain flake.lock", "flake_lock_missing");
    }
    fs.rmSync(releaseDir, { recursive: true, force: true });
    fs.renameSync(staging, releaseDir);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

export function validateZipCentralDirectory(archive: Buffer) {
  const minimumEocdBytes = 22;
  const searchStart = Math.max(0, archive.length - 65_557);
  let eocd = -1;
  for (let offset = archive.length - minimumEocdBytes; offset >= searchStart; offset--) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) {
    throw new HttpError(400, "Harbur snapshot has no ZIP directory", "harbur_archive");
  }
  const disk = archive.readUInt16LE(eocd + 4);
  const directoryDisk = archive.readUInt16LE(eocd + 6);
  const diskEntries = archive.readUInt16LE(eocd + 8);
  const totalEntries = archive.readUInt16LE(eocd + 10);
  const directoryBytes = archive.readUInt32LE(eocd + 12);
  const directoryOffset = archive.readUInt32LE(eocd + 16);
  const commentBytes = archive.readUInt16LE(eocd + 20);
  if (
    disk !== 0 ||
    directoryDisk !== 0 ||
    diskEntries !== totalEntries ||
    totalEntries === 0xffff ||
    directoryBytes === 0xffffffff ||
    directoryOffset === 0xffffffff ||
    eocd + minimumEocdBytes + commentBytes !== archive.length
  ) {
    throw new HttpError(400, "Harbur snapshot uses an unsupported ZIP layout", "harbur_archive");
  }
  if (totalEntries > MAX_ARCHIVE_ENTRIES || directoryOffset + directoryBytes > eocd) {
    throw new HttpError(400, "Harbur snapshot ZIP directory is invalid", "harbur_archive");
  }

  const sizes = new Map<string, number>();
  let totalBytes = 0;
  let cursor = directoryOffset;
  const directoryEnd = directoryOffset + directoryBytes;
  for (let index = 0; index < totalEntries; index++) {
    if (cursor + 46 > directoryEnd || archive.readUInt32LE(cursor) !== 0x02014b50) {
      throw new HttpError(400, "Harbur snapshot ZIP directory is invalid", "harbur_archive");
    }
    const flags = archive.readUInt16LE(cursor + 8);
    const compression = archive.readUInt16LE(cursor + 10);
    const compressedBytes = archive.readUInt32LE(cursor + 20);
    const uncompressedBytes = archive.readUInt32LE(cursor + 24);
    const nameBytes = archive.readUInt16LE(cursor + 28);
    const extraBytes = archive.readUInt16LE(cursor + 30);
    const entryCommentBytes = archive.readUInt16LE(cursor + 32);
    const startDisk = archive.readUInt16LE(cursor + 34);
    const externalAttributes = archive.readUInt32LE(cursor + 38);
    const recordBytes = 46 + nameBytes + extraBytes + entryCommentBytes;
    if (
      cursor + recordBytes > directoryEnd ||
      startDisk !== 0 ||
      (flags & 1) !== 0 ||
      ![0, 8].includes(compression) ||
      compressedBytes === 0xffffffff ||
      uncompressedBytes === 0xffffffff
    ) {
      throw new HttpError(400, "Harbur snapshot ZIP entry is unsupported", "harbur_archive");
    }
    const rawName = archive.subarray(cursor + 46, cursor + 46 + nameBytes).toString("utf8");
    if (rawName.includes("�")) {
      throw new HttpError(400, "Harbur snapshot has an invalid file name", "harbur_archive");
    }
    validateArchivePath(rawName);
    if (sizes.has(rawName)) {
      throw new HttpError(400, "Harbur snapshot contains duplicate paths", "harbur_archive");
    }
    const fileType = (externalAttributes >>> 16) & 0o170000;
    if (fileType !== 0 && fileType !== 0o100000 && fileType !== 0o040000) {
      throw new HttpError(400, "Harbur snapshot contains a non-regular file", "harbur_archive");
    }
    if (uncompressedBytes > MAX_FILE_BYTES) {
      throw new HttpError(400, "Harbur snapshot contains an oversized file", "harbur_archive");
    }
    totalBytes += uncompressedBytes;
    if (totalBytes > MAX_EXTRACTED_BYTES) {
      throw new HttpError(400, "Harbur snapshot expands beyond the allowed size", "harbur_archive");
    }
    sizes.set(rawName, uncompressedBytes);
    cursor += recordBytes;
  }
  if (cursor !== directoryEnd) {
    throw new HttpError(400, "Harbur snapshot ZIP directory is inconsistent", "harbur_archive");
  }
  return sizes;
}

function validateArchivePath(name: string, unsafeOriginalName?: string) {
  if (
    !name ||
    name.includes("\\") ||
    name.includes("\0") ||
    name.startsWith("/") ||
    /^[A-Za-z]:/.test(name) ||
    name.split("/").some((segment) => segment === ".." || segment === ".") ||
    (unsafeOriginalName !== undefined && unsafeOriginalName !== name)
  ) {
    throw new HttpError(400, "Harbur snapshot contains an unsafe path", "harbur_archive");
  }
}

function publicConnection(connection: IntegrationConnectionRow) {
  return {
    id: connection.id,
    provider: connection.provider,
    baseUrl: connection.base_url,
    allowPrivateNetwork: Boolean(connection.allow_private_network),
    privateAccess: Boolean(connection.token_encrypted),
    eventCursor: connection.event_cursor,
    status: connection.status,
    lastError: connection.last_error,
    createdAt: connection.created_at,
    updatedAt: connection.updated_at,
  };
}
