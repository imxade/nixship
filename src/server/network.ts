import fs from "node:fs";
import os from "node:os";

type NetworkInterfaces = ReturnType<typeof os.networkInterfaces>;

export function safeNetworkInterfaces(
  read: () => NetworkInterfaces = os.networkInterfaces,
): NetworkInterfaces {
  try {
    return read();
  } catch {
    return {};
  }
}

export function lanHttpUrls(
  port: number,
  networkInterfaces?: NetworkInterfaces,
  preferredInterface: string | null = defaultRouteInterface(),
  explicitAddress: string | null = process.env.LAN_ADDRESS?.trim() || null,
  disableDiscovery = process.env.DISABLE_LAN_DISCOVERY === "1",
): string[] {
  if (explicitAddress && isIpv4(explicitAddress) && !isLoopbackIpv4(explicitAddress)) {
    return [`http://${explicitAddress}:${port}`];
  }
  if (disableDiscovery) return [];

  const addresses: Array<{ address: string; interfaceName: string; rank: number }> = [];
  for (const [interfaceName, interfaces] of Object.entries(
    networkInterfaces ?? safeNetworkInterfaces(),
  )) {
    for (const address of interfaces ?? []) {
      if (address.internal || String(address.family) !== "IPv4") continue;
      addresses.push({
        address: address.address,
        interfaceName,
        rank: interfaceRank(interfaceName, address.address, preferredInterface),
      });
    }
  }
  const primary = addresses.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.interfaceName.localeCompare(b.interfaceName) ||
      a.address.localeCompare(b.address),
  )[0];
  return primary ? [`http://${primary.address}:${port}`] : [];
}

function interfaceRank(
  interfaceName: string,
  address: string,
  preferredInterface: string | null,
): number {
  if (interfaceName === preferredInterface) return 0;
  const virtual = /^(br-|docker|podman|tailscale|tun|veth|virbr|vmnet|wg)/i.test(interfaceName);
  const physical = /^(ap|bond|en|eth|wl|wlan)/i.test(interfaceName);
  return (virtual ? 100 : physical ? 10 : 20) + (isPrivateIpv4(address) ? 0 : 5);
}

function isPrivateIpv4(address: string): boolean {
  const [first = Number.NaN, second = Number.NaN] = address.split(".").map(Number);
  return (
    isIpv4(address) &&
    (first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 100 && second >= 64 && second <= 127))
  );
}

function isIpv4(address: string): boolean {
  const octets = address.split(".");
  return (
    octets.length === 4 &&
    octets.every(
      (octet) => /^(0|[1-9][0-9]{0,2})$/.test(octet) && Number(octet) >= 0 && Number(octet) <= 255,
    )
  );
}

function isLoopbackIpv4(address: string): boolean {
  return address.startsWith("127.");
}

function defaultRouteInterface(): string | null {
  if (process.platform !== "linux") return null;
  try {
    const routes = fs.readFileSync("/proc/net/route", "utf8").trim().split("\n").slice(1);
    const defaults = routes
      .map((line) => line.trim().split(/\s+/))
      .filter(
        (fields) => fields[1] === "00000000" && (Number.parseInt(fields[3] ?? "0", 16) & 1) === 1,
      )
      .sort((a, b) => Number(a[6] ?? 0) - Number(b[6] ?? 0));
    return defaults[0]?.[0] ?? null;
  } catch {
    return null;
  }
}
