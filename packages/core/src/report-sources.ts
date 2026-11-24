import type { ReportSource } from "@aut/protocol";
import { Schema } from "effect";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmAutolinkLiteralFromMarkdown } from "mdast-util-gfm-autolink-literal";
import { gfmAutolinkLiteral } from "micromark-extension-gfm-autolink-literal";

interface MarkdownNode {
  readonly type: string;
  readonly value?: string;
  readonly url?: string;
  readonly identifier?: string;
  readonly children?: readonly MarkdownNode[];
  readonly position?:
    | {
        readonly start: { readonly offset?: number | undefined };
        readonly end: { readonly offset?: number | undefined };
      }
    | undefined;
}
interface Replacement {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

const plainText = (node: MarkdownNode): string =>
  node.value ?? node.children?.map(plainText).join("") ?? "";
const escapeLabel = (text: string) => text.replace(/[\\`*_[\]<>]/g, "\\$&");

const inspectReport = (report: string) => {
  const root = fromMarkdown(report, {
    extensions: [gfmAutolinkLiteral()],
    mdastExtensions: [gfmAutolinkLiteralFromMarkdown()],
  });
  const definitions = new Map<string, string>();
  const replacements: Replacement[] = [];
  const sources: ReportSource[] = [];
  const seen = new Set<string>();
  const replace = (node: MarkdownNode, text: string) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start !== undefined && end !== undefined) replacements.push({ start, end, text });
  };
  const collectDefinitions = (node: MarkdownNode) => {
    if (
      node.type === "definition" &&
      node.identifier &&
      node.url &&
      !definitions.has(node.identifier)
    )
      definitions.set(node.identifier, node.url);
    for (const child of node.children ?? []) collectDefinitions(child);
  };
  collectDefinitions(root);
  const visit = (node: MarkdownNode) => {
    if (["code", "inlineCode", "html", "image", "imageReference"].includes(node.type)) return;
    if (node.type === "definition") {
      replace(node, "");
      return;
    }
    if (node.type === "link" || node.type === "linkReference") {
      const candidate = node.url ?? definitions.get(node.identifier ?? "");
      if (!candidate) return;
      const start = node.position?.start.offset ?? 0;
      const bare = /^https?:\/\//i.test(report.slice(start));
      const url = bare ? candidate.replace(/[。，、！？；：”’）】》〉」』]+$/u, "") : candidate;
      const parsed = Schema.decodeUnknownOption(Schema.URL)(url);
      if (
        parsed._tag === "None" ||
        !["http:", "https:"].includes(parsed.value.protocol) ||
        parsed.value.username ||
        parsed.value.password
      )
        return;
      const originalLabel = plainText(node).trim();
      const label =
        !bare && originalLabel && originalLabel !== candidate
          ? originalLabel
          : parsed.value.hostname;
      replace(node, escapeLabel(label) + (bare ? candidate.slice(url.length) : ""));
      if (!seen.has(url) && sources.length < 32) {
        seen.add(url);
        sources.push({ url, label: Array.from(label).slice(0, 120).join("") });
      }
      return;
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
  return { sources, replacements };
};

/** Reference metadata always comes from the immutable successful report, never its rewrite. */
export const reportSources = (report: string): readonly ReportSource[] =>
  inspectReport(report).sources;

/** The final fallback keeps readable labels; complete addresses travel in source metadata. */
export const reportTextForTruncation = (report: string): string => {
  const { replacements } = inspectReport(report);
  let text = report;
  for (const replacement of replacements.sort((a, b) => b.start - a.start))
    text = text.slice(0, replacement.start) + replacement.text + text.slice(replacement.end);
  return text;
};
