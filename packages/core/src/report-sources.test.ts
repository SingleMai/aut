import { ReportSources } from "@aut/protocol";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { reportSources, reportTextForTruncation } from "./report-sources.js";

it("preserves complete Markdown, reference, autolink and bare URLs in original order", () => {
  const long = `https://example.com/a_(b)?q=${"very-long-value".repeat(30)}&lang=zh#sources`;
  const report = `参考 [官方 **文档**](${long})、[说明][intro]。\n\n资料：https://other.test/intro。\n\n<https://third.test/>\n\n重复 [文档](${long})\n\n[intro]: https://example.com/start?a=1&b=2`;
  expect(reportSources(report)).toEqual([
    { url: long, label: "官方 文档" },
    { url: "https://example.com/start?a=1&b=2", label: "说明" },
    { url: "https://other.test/intro", label: "other.test" },
    { url: "https://third.test/", label: "third.test" },
  ]);
  const text = reportTextForTruncation(report);
  expect(text).toContain("资料：other.test。");
  expect(text).toContain("官方 文档");
  expect(text).not.toContain("https://");
  expect(text).not.toContain("[intro]:");
});

it("ignores executable examples, images, raw HTML, unused definitions and unsafe schemes", () => {
  const report = [
    "`https://code.test/inline`",
    "```md\n[example](https://code.test/fenced)\n```",
    "![image](https://image.test/) ![ref][image]",
    "<div>https://html.test/</div>",
    "[local](file:///tmp/report) [script](javascript:alert%281%29)",
    "[secret](https://name:password@private.test/) [user](https://name@private.test/)",
    "[unused]: https://unused.test/",
    "[image]: https://image.test/ref",
  ].join("\n\n");
  expect(reportSources(report)).toEqual([]);
});

it("bounds labels and source counts without modifying the copied address", () => {
  const report = Array.from(
    { length: 34 },
    (_, i) => `[${"😀".repeat(130)}](https://example.com/${i})`,
  ).join("\n");
  const sources = reportSources(report);
  expect(sources).toHaveLength(32);
  expect(sources[0]).toEqual({ url: "https://example.com/0", label: "😀".repeat(120) });
  expect(sources[31]?.url).toBe("https://example.com/31");
  expect(Schema.is(ReportSources)(sources)).toBe(true);
  expect(reportTextForTruncation(report)).not.toContain("https://");
});

it("preserves escaped labels, Unicode offsets and meaningful URL punctuation", () => {
  const report = "😀 [a\\[b\\]](https://example.com/a_(b)?q=a%20b&v=2#part)";
  expect(reportSources(report)).toEqual([
    { url: "https://example.com/a_(b)?q=a%20b&v=2#part", label: "a[b]" },
  ]);
  expect(reportTextForTruncation(report)).toBe("😀 a\\[b\\]");
  expect(reportSources("No references here.")).toEqual([]);
});
