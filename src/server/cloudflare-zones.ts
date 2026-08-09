import { cloudflareApiRequest } from "./cloudflare-api.ts";
import { getDb, nowIso } from "./db.ts";
import { updateDomainAssignment } from "./domain-assignments.ts";
import { registrableDomain } from "./domain-name.ts";
import { HttpError } from "./errors.ts";

interface CloudflareZoneResult {
  id: string;
  name: string;
  status: "initializing" | "pending" | "active" | "moved";
  name_servers?: string[];
  original_name_servers?: string[];
  original_registrar?: string;
  activated_on?: string | null;
}

export interface DomainZoneRow {
  apex: string;
  cloudflare_zone_id: string;
  state: "discovered" | "pending-delegation" | "active" | "error";
  assigned_nameservers: string;
  observed_nameservers: string;
  original_nameservers: string;
  observed_records: string;
  original_registrar: string | null;
  inventory_confirmed_at: string | null;
  activated_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface DomainZoneSummary {
  apex: string;
  zoneId: string;
  state: DomainZoneRow["state"];
  assignedNameservers: string[];
  observedNameservers: string[];
  originalNameservers: string[];
  observedRecords: ObservedDnsRecord[];
  originalRegistrar: string | null;
  inventoryConfirmed: boolean;
  activatedAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
}

export interface ObservedDnsRecord {
  type: "A" | "AAAA" | "CNAME" | "MX" | "TXT" | "CAA" | "DS";
  value: string;
}

export function domainZones(): DomainZoneRow[] {
  return getDb().prepare("SELECT * FROM domain_zones ORDER BY apex").all() as DomainZoneRow[];
}

export function domainZoneSummaries(): DomainZoneSummary[] {
  return domainZones().map((zone) => ({
    apex: zone.apex,
    zoneId: zone.cloudflare_zone_id,
    state: zone.state,
    assignedNameservers: parseNameservers(zone.assigned_nameservers),
    observedNameservers: parseNameservers(zone.observed_nameservers),
    originalNameservers: parseNameservers(zone.original_nameservers),
    observedRecords: parseObservedRecords(zone.observed_records),
    originalRegistrar: zone.original_registrar,
    inventoryConfirmed: Boolean(zone.inventory_confirmed_at),
    activatedAt: zone.activated_at,
    lastCheckedAt: zone.last_checked_at,
    lastError: zone.last_error,
  }));
}

export async function ensureDomainZone(input: {
  accountId: string;
  apiToken: string;
  hostname: string;
}): Promise<{ apex: string; zoneId: string; active: boolean }> {
  const apex = registrableDomain(input.hostname);
  const zones = await cloudflareApiRequest<CloudflareZoneResult[]>(
    input.apiToken,
    `/zones?account.id=${encodeURIComponent(input.accountId)}&name=${encodeURIComponent(apex)}&per_page=1`,
  );
  const zone =
    zones[0] ??
    (await cloudflareApiRequest<CloudflareZoneResult>(input.apiToken, "/zones", {
      method: "POST",
      body: JSON.stringify({ account: { id: input.accountId }, name: apex, type: "full" }),
    }));
  const [observedNameservers, observedRecords] = await Promise.all([
    publicNameservers(apex),
    publicDnsInventory(apex),
  ]);
  const assignedNameservers = normalizedNameservers(zone.name_servers ?? []);
  const delegated = sameNameservers(assignedNameservers, observedNameservers);
  const existing = getDb()
    .prepare("SELECT inventory_confirmed_at FROM domain_zones WHERE apex = ?")
    .get(apex) as { inventory_confirmed_at: string | null } | undefined;
  const inventoryConfirmedAt =
    existing?.inventory_confirmed_at ?? (zone.status === "active" ? nowIso() : null);
  const active = zone.status === "active" && delegated && Boolean(inventoryConfirmedAt);
  const now = nowIso();
  getDb()
    .prepare(
      `INSERT INTO domain_zones(
        apex, cloudflare_zone_id, state, assigned_nameservers, observed_nameservers,
        original_nameservers, observed_records, original_registrar, inventory_confirmed_at,
        activated_at, last_checked_at, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
      ON CONFLICT(apex) DO UPDATE SET
        cloudflare_zone_id = excluded.cloudflare_zone_id,
        state = excluded.state,
        assigned_nameservers = excluded.assigned_nameservers,
        observed_nameservers = excluded.observed_nameservers,
        original_nameservers = excluded.original_nameservers,
        observed_records = excluded.observed_records,
        original_registrar = excluded.original_registrar,
        inventory_confirmed_at = excluded.inventory_confirmed_at,
        activated_at = excluded.activated_at,
        last_checked_at = excluded.last_checked_at,
        last_error = NULL,
        updated_at = excluded.updated_at`,
    )
    .run(
      apex,
      zone.id,
      active ? "active" : "pending-delegation",
      JSON.stringify(assignedNameservers),
      JSON.stringify(observedNameservers),
      JSON.stringify(normalizedNameservers(zone.original_name_servers ?? [])),
      JSON.stringify(observedRecords),
      zone.original_registrar ?? null,
      inventoryConfirmedAt,
      active ? (zone.activated_on ?? now) : null,
      now,
      now,
      now,
    );
  updateDomainAssignment(input.hostname, {
    state: active ? "provisioning" : "waiting-zone",
    zoneId: zone.id,
    lastError: active ? null : `Update the nameservers for ${apex}, then check delegation`,
  });
  getDb()
    .prepare("UPDATE domain_assignments SET apex = ?, updated_at = ? WHERE hostname = ?")
    .run(apex, now, input.hostname);
  return { apex, zoneId: zone.id, active };
}

export function confirmDomainZoneInventory(apex: string): void {
  const result = getDb()
    .prepare(
      `UPDATE domain_zones SET inventory_confirmed_at = ?, updated_at = ?
       WHERE apex = ?`,
    )
    .run(nowIso(), nowIso(), apex);
  if (result.changes === 0) {
    throw new HttpError(404, "Domain zone not found", "domain_zone_not_found");
  }
}

async function publicNameservers(apex: string): Promise<string[]> {
  const answers = await publicDnsAnswers(apex, "NS");
  return normalizedNameservers(
    answers.filter((answer) => answer.type === 2).map((answer) => answer.data),
  );
}

async function publicDnsInventory(apex: string): Promise<ObservedDnsRecord[]> {
  const types = ["A", "AAAA", "CNAME", "MX", "TXT", "CAA", "DS"] as const;
  const answers = (await Promise.all(types.map((type) => publicDnsAnswers(apex, type)))).flat();
  const typeNames = new Map<number, ObservedDnsRecord["type"]>([
    [1, "A"],
    [28, "AAAA"],
    [5, "CNAME"],
    [15, "MX"],
    [16, "TXT"],
    [257, "CAA"],
    [43, "DS"],
  ]);
  const records = answers.flatMap((answer) => {
    const type = typeNames.get(answer.type);
    return type ? [{ type, value: answer.data.trim() }] : [];
  });
  return [
    ...new Map(records.map((record) => [`${record.type}\0${record.value}`, record])).values(),
  ].sort((left, right) =>
    `${left.type} ${left.value}`.localeCompare(`${right.type} ${right.value}`),
  );
}

async function publicDnsAnswers(
  apex: string,
  type: string,
): Promise<Array<{ type: number; data: string }>> {
  try {
    const response = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(apex)}&type=${type}`,
      {
        headers: { accept: "application/dns-json" },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) return [];
    const body = (await response.json()) as {
      Answer?: Array<{ type: number; data: string }>;
    };
    return body.Answer ?? [];
  } catch {
    return [];
  }
}

function normalizedNameservers(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim().replace(/\.$/, "").toLowerCase()))].sort();
}

function sameNameservers(expected: string[], observed: string[]): boolean {
  return expected.length > 0 && JSON.stringify(expected) === JSON.stringify(observed);
}

function parseNameservers(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}

function parseObservedRecords(value: string): ObservedDnsRecord[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is ObservedDnsRecord =>
        typeof item === "object" &&
        item !== null &&
        "type" in item &&
        "value" in item &&
        typeof item.type === "string" &&
        typeof item.value === "string",
    );
  } catch {
    return [];
  }
}
