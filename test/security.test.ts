import { describe, expect, it } from "vitest";
import { assertPublicHttpUrl, isPrivateIp } from "../src/web/security.js";

describe("web URL security", () => {
  it.each(["127.0.0.1", "10.0.0.1", "172.16.1.1", "192.168.1.1", "169.254.169.254", "::1", "fd00::1", "fec0::1", "fe80::1", "ff02::1", "::ffff:7f00:1"])(
    "blocks private address %s",
    (address) => expect(isPrivateIp(address)).toBe(true),
  );

  it.each(["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])("allows public address %s", (address) => {
    expect(isPrivateIp(address)).toBe(false);
  });

  it("blocks localhost and non-http schemes", async () => {
    await expect(assertPublicHttpUrl("http://localhost/admin")).rejects.toThrow("Local");
    await expect(assertPublicHttpUrl("file:///etc/passwd")).rejects.toThrow("HTTP");
  });

  it("allows public IPv6 URL literals", async () => {
    await expect(assertPublicHttpUrl("https://[2606:4700:4700::1111]/")).resolves.toBeInstanceOf(URL);
  });

  it("blocks private IPv4-mapped IPv6 URL literals", async () => {
    await expect(assertPublicHttpUrl("http://[::ffff:7f00:1]/")).rejects.toThrow("Private");
  });

  it("blocks non-standard ports", async () => {
    await expect(assertPublicHttpUrl("https://1.1.1.1:8443/")).rejects.toThrow("standard");
  });
});
