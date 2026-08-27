import { describe, expect, test } from "bun:test";
import { parseOpenArgs } from "../open-args.ts";

describe("parseOpenArgs", () => {
  test("a plain url with no flags: active is false", () => {
    expect(parseOpenArgs(["https://example.com"])).toEqual({ url: "https://example.com", active: false });
  });

  test("--active after the url", () => {
    expect(parseOpenArgs(["https://example.com", "--active"])).toEqual({ url: "https://example.com", active: true });
  });

  test("--active before the url (order-independent)", () => {
    expect(parseOpenArgs(["--active", "https://example.com"])).toEqual({ url: "https://example.com", active: true });
  });

  test("no args at all: url is undefined, active is false", () => {
    expect(parseOpenArgs([])).toEqual({ url: undefined, active: false });
  });

  test("--active with no url: url is undefined, active is true", () => {
    expect(parseOpenArgs(["--active"])).toEqual({ url: undefined, active: true });
  });
});
