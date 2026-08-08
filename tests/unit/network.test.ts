import type os from "node:os";
import { describe, expect, it } from "vitest";
import { lanHttpUrls, safeNetworkInterfaces } from "../../src/server/network.ts";

type NetworkInterfaces = ReturnType<typeof os.networkInterfaces>;

describe("LAN URL selection", () => {
  it("degrades safely when the platform denies interface discovery", () => {
    expect(
      safeNetworkInterfaces(() => {
        throw new Error("uv_interface_addresses denied");
      }),
    ).toEqual({});
  });

  it("uses an explicit platform-provided address without native discovery", () => {
    expect(lanHttpUrls(3000, undefined, null, "192.168.20.41", true)).toEqual([
      "http://192.168.20.41:3000",
    ]);
  });

  it("returns no LAN URL when unsafe discovery is disabled and no address is available", () => {
    expect(lanHttpUrls(3000, undefined, null, null, true)).toEqual([]);
  });

  it("returns only the preferred route's IPv4 address", () => {
    const interfaces = {
      wlp3s0: [
        address("10.25.230.245", "IPv4"),
        address("2409:40e0:4c:ad8::1", "IPv6"),
        address("fe80::1", "IPv6"),
      ],
      docker0: [address("172.17.0.1", "IPv4")],
    } as NetworkInterfaces;

    expect(lanHttpUrls(3000, interfaces, "wlp3s0")).toEqual(["http://10.25.230.245:3000"]);
  });

  it("prefers a physical private IPv4 address when no default route is known", () => {
    const interfaces = {
      docker0: [address("172.17.0.1", "IPv4")],
      wlan0: [address("192.168.1.12", "IPv4")],
    } as NetworkInterfaces;

    expect(lanHttpUrls(4100, interfaces, null)).toEqual(["http://192.168.1.12:4100"]);
  });
});

function address(value: string, family: "IPv4" | "IPv6"): os.NetworkInterfaceInfo {
  const common = {
    address: value,
    internal: false,
    mac: "00:00:00:00:00:01",
    cidr: null,
  } as const;
  return family === "IPv4"
    ? { ...common, family, netmask: "255.255.255.0" }
    : { ...common, family, netmask: "ffff:ffff:ffff:ffff::", scopeid: 0 };
}
