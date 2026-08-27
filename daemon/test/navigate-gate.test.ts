import { describe, expect, test } from "bun:test";
import { decideNavigate } from "../src/navigate-gate.ts";

describe("decideNavigate -- scheme gate", () => {
  test("allows a plain https URL with no private-range IPs", () => {
    expect(decideNavigate("https://example.com/page", [], ["93.184.216.34"])).toEqual({ action: "allow" });
  });

  test("allows a plain http URL", () => {
    expect(decideNavigate("http://example.com/page", [], ["93.184.216.34"])).toEqual({ action: "allow" });
  });

  test("blocks a file:// URL", () => {
    const d = decideNavigate("file:///etc/passwd", [], []);
    expect(d.action).toBe("block");
  });

  test("blocks a chrome:// URL", () => {
    const d = decideNavigate("chrome://settings", [], []);
    expect(d.action).toBe("block");
  });

  test("blocks an unparseable URL", () => {
    const d = decideNavigate("not a url", [], []);
    expect(d.action).toBe("block");
  });
});

describe("decideNavigate -- loopback / localhost", () => {
  test("blocks localhost when its port isn't in the observed-ports allowlist", () => {
    const d = decideNavigate("http://localhost:9999", [], []);
    expect(d.action).toBe("block");
  });

  test("allows localhost when its port IS an observed metamux port", () => {
    expect(decideNavigate("http://localhost:3000", [3000], [])).toEqual({ action: "allow" });
  });

  test("allows 127.0.0.1 with an observed port", () => {
    expect(decideNavigate("http://127.0.0.1:5173/app", [5173], [])).toEqual({ action: "allow" });
  });

  test("allows ::1 with an observed port", () => {
    expect(decideNavigate("http://[::1]:8080", [8080], [])).toEqual({ action: "allow" });
  });

  test("blocks 127.0.0.1 with no port allowlisted", () => {
    const d = decideNavigate("http://127.0.0.1:8080/", [3000], []);
    expect(d.action).toBe("block");
  });

  test("defaults to port 80/443 for a portless loopback URL", () => {
    // localhost with no explicit port -> port 80 (http); not observed -> block
    const d = decideNavigate("http://localhost/", [], []);
    expect(d.action).toBe("block");
    expect(decideNavigate("http://localhost/", [80], [])).toEqual({ action: "allow" });
  });
});

describe("decideNavigate -- IPv4 private/reserved ranges", () => {
  const cases: [string, boolean][] = [
    ["10.0.0.5", true],
    ["10.255.255.255", true],
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["172.15.255.255", false], // just outside 172.16.0.0/12
    ["172.32.0.0", false], // just outside
    ["192.168.1.1", true],
    ["169.254.169.254", true], // cloud metadata, link-local
    ["169.254.1.1", true],
    ["100.64.0.1", true], // CGNAT
    ["0.0.0.0", true],
    ["8.8.8.8", false],
    ["93.184.216.34", false],
    ["1.1.1.1", false],
  ];
  for (const [ip, blocked] of cases) {
    test(`${ip} is ${blocked ? "blocked" : "allowed"}`, () => {
      const d = decideNavigate("https://example.com/", [], [ip]);
      expect(d.action).toBe(blocked ? "block" : "allow");
    });
  }
});

describe("decideNavigate -- IPv6 private/reserved ranges", () => {
  const cases: [string, boolean][] = [
    ["::1", true], // loopback
    ["fe80::1", true], // link-local
    ["fec0::1", false], // outside fe80::/10 (fe80-febf)
    ["fc00::1", true], // unique local
    ["fd12:3456::1", true], // unique local
    ["::ffff:192.168.1.1", true], // IPv4-mapped private
    ["::ffff:8.8.8.8", false], // IPv4-mapped public
    ["2001:4860:4860::8888", false], // public (Google DNS)
  ];
  for (const [ip, blocked] of cases) {
    test(`${ip} is ${blocked ? "blocked" : "allowed"}`, () => {
      const d = decideNavigate("https://example.com/", [], [ip]);
      expect(d.action).toBe(blocked ? "block" : "allow");
    });
  }
});

describe("decideNavigate -- multiple resolved IPs", () => {
  test("blocks if ANY resolved IP is private, even if others are public (DNS rebinding defense)", () => {
    const d = decideNavigate("https://example.com/", [], ["93.184.216.34", "10.0.0.1"]);
    expect(d.action).toBe("block");
  });

  test("allows when every resolved IP is public", () => {
    expect(decideNavigate("https://example.com/", [], ["93.184.216.34", "1.1.1.1"])).toEqual({ action: "allow" });
  });

  test("an empty resolvedIps list (DNS resolution failed upstream) fails CLOSED, not open", () => {
    const d = decideNavigate("https://example.com/", [], []);
    expect(d.action).toBe("block");
  });
});
