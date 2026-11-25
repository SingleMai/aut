import { expect, it } from "vitest";
import { resolveMemoryLink } from "./memory.js";

it.each([
  ["MEMORY.md", "knowledge/release.md", "knowledge/release.md"],
  ["knowledge/project/release.md", "../environment.md#setup", "knowledge/environment.md"],
  ["knowledge/project/release.md", "../../MEMORY.md?mode=read#summary", "MEMORY.md"],
  ["knowledge/release.md", "../notes/session.md", "notes/session.md"],
  [
    "notes/session.md",
    "../knowledge/%E7%8E%AF%E5%A2%83%20%E9%85%8D%E7%BD%AE.md",
    "knowledge/环境 配置.md",
  ],
  ["knowledge/release.md", "./project/../environment.md", "knowledge/environment.md"],
  ["knowledge/release.md", "question%3F%23.md#heading", "knowledge/question?#.md"],
])("resolves %s → %s within memory", (source, href, expected) => {
  expect(resolveMemoryLink(source, href)).toBe(expected);
});

it.each([
  "https://example.com/fact.md",
  "file:///tmp/fact.md",
  "javascript:alert(1)",
  "https%3A%2F%2Fexample.com/fact.md",
  "//example.com/fact.md",
  "/knowledge/fact.md",
  "%2Fknowledge/fact.md",
  "../../knowledge/escape.md",
  "%2e%2e/%2e%2e/knowledge/escape.md",
  "../config.json",
  "../outside.md",
  "..\\knowledge\\escape.md",
  "a%00.md",
  "a%0a.md",
  "bad%zz.md",
  "target.md/",
  "target.md/%2e",
  "target.md/child/..",
  "#section",
  "?query=value",
  "",
])("does not grant navigation for %s", (href) => {
  expect(resolveMemoryLink("knowledge/release.md", href)).toBeUndefined();
});

it("rejects an invalid source before resolving its link", () => {
  expect(resolveMemoryLink("../knowledge/source.md", "target.md")).toBeUndefined();
});
