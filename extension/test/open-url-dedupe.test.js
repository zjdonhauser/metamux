import { describe, expect, test } from "bun:test";
import { findExistingTab } from "../chrome-ops.js";

const tab = (id, url) => ({ id, url });

describe("findExistingTab", () => {
  test("finds a tab whose url matches exactly", () => {
    const tabs = [tab(1, "https://a.example"), tab(2, "https://b.example")];
    expect(findExistingTab(tabs, "https://b.example")).toEqual(tab(2, "https://b.example"));
  });

  test("returns undefined when no tab matches", () => {
    expect(findExistingTab([tab(1, "https://a.example")], "https://z.example")).toBeUndefined();
  });

  test("returns undefined for an empty group", () => {
    expect(findExistingTab([], "https://a.example")).toBeUndefined();
  });

  // A tab mid-navigation can report an empty or undefined url. That must
  // never match, or a duplicate open could silently reactivate the wrong tab.
  test("never matches a tab with no url yet", () => {
    const tabs = [{ id: 1, url: "" }, { id: 2 }];
    expect(findExistingTab(tabs, "")).toBeUndefined();
    expect(findExistingTab(tabs, "https://a.example")).toBeUndefined();
  });

  test("picks the first match when duplicates already exist", () => {
    const tabs = [tab(1, "https://a.example"), tab(2, "https://a.example")];
    expect(findExistingTab(tabs, "https://a.example").id).toBe(1);
  });
});
