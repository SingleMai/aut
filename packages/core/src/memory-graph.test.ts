import { BotId, type MemoryFile, MemoryGraphResponse } from "@aut/protocol";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { buildMemoryGraph } from "./memory-graph.js";

const document = (path: string, content = ""): MemoryFile => ({
  path,
  content,
  updatedAt: 42,
  bytes: Buffer.byteLength(content),
});
const botId = BotId.make("fixture");

it("derives directed, deduplicated knowledge links and readable titles from Markdown", () => {
  const graph = buildMemoryGraph(botId, [
    document("MEMORY.md", "# Core\n[Release](knowledge/主题/发布.md)"),
    document("notes/session.md", "[Release](../knowledge/主题/发布.md)"),
    document(
      "knowledge/主题/发布.md",
      [
        "# 发布 **流程** `v2`",
        "[环境](../%E7%8E%AF%E5%A2%83%E9%85%8D%E7%BD%AE.md#setup)",
        "[Same environment][env]",
        "[env]: ../环境配置.md",
        "[Missing](missing.md) [Missing again](missing.md#section)",
        "[Core](../../MEMORY.md) [Note](../../notes/session.md)",
        "[Section](#details) [Self](发布.md#details)",
        "[Remote](https://example.com/fact.md) [Escape](../../../knowledge/elsewhere.md)",
        "[Directory, not a document](ghost.md/) [Directory dot](ghost.md/.)",
        "![Image](image.md) ![Image reference][image]",
        "[image]: image-reference.md",
        "`[Inline code](inline.md)`",
        "```md\n[Fenced code](fenced.md)\n```",
        '<a href="html.md">HTML</a>',
      ].join("\n\n"),
    ),
    document("knowledge/环境配置.md", "[Back](主题/发布.md)"),
    document("knowledge/unlinked.md", "This page has no links."),
  ]);
  expect(Schema.is(MemoryGraphResponse)(graph)).toBe(true);
  expect(graph.nodes).toEqual([
    { path: "knowledge/主题/发布.md", title: "发布 流程 v2", updatedAt: 42 },
    { path: "knowledge/环境配置.md", title: "环境配置", updatedAt: 42 },
    { path: "knowledge/unlinked.md", title: "unlinked", updatedAt: 42 },
  ]);
  expect(graph.edges).toEqual([
    { source: "knowledge/主题/发布.md", target: "knowledge/环境配置.md" },
    { source: "knowledge/环境配置.md", target: "knowledge/主题/发布.md" },
  ]);
  expect(graph.brokenLinks).toEqual([
    { source: "knowledge/主题/发布.md", target: "knowledge/主题/missing.md" },
  ]);
});

it("uses the first reference definition and does not invent nodes for missing files", () => {
  const graph = buildMemoryGraph(botId, [
    document("knowledge/plan.md", "[Environment][A]\n\n[A]: target.md\n[A]: other.md"),
    document("knowledge/target.md", "# Environment\n\n# Later heading"),
    document("knowledge/.md"),
  ]);
  expect(graph.edges).toEqual([{ source: "knowledge/plan.md", target: "knowledge/target.md" }]);
  expect(graph.nodes[1]?.title).toBe("Environment");
  expect(graph.nodes[2]?.title).toBe(".md");
  expect(graph.brokenLinks).toEqual([]);
  expect(buildMemoryGraph(botId, [])).toEqual({ botId, nodes: [], edges: [], brokenLinks: [] });
});
