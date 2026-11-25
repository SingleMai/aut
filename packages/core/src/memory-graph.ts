import {
  type BotId,
  type MemoryFile,
  type MemoryGraphEdge,
  type MemoryGraphResponse,
  resolveMemoryLink,
} from "@aut/protocol";
import { fromMarkdown } from "mdast-util-from-markdown";

interface MarkdownNode {
  readonly type: string;
  readonly depth?: number;
  readonly value?: string;
  readonly url?: string;
  readonly identifier?: string;
  readonly children?: readonly MarkdownNode[];
}

const plainText = (node: MarkdownNode): string =>
  node.value ?? node.children?.map(plainText).join("") ?? "";

/** The graph is rebuilt from explicit Markdown links; it has no separate stored state. */
export const buildMemoryGraph = (
  botId: BotId,
  documents: readonly MemoryFile[],
): MemoryGraphResponse => {
  const knowledge = documents.filter((file) => file.path.startsWith("knowledge/"));
  const paths = new Set(knowledge.map((file) => file.path));
  const edges: MemoryGraphEdge[] = [];
  const brokenLinks: MemoryGraphEdge[] = [];
  const nodes = knowledge.map((file) => {
    const root = fromMarkdown(file.content);
    const definitions = new Map<string, string>();
    let title: string | undefined;
    const collect = (node: MarkdownNode) => {
      if (
        node.type === "definition" &&
        node.identifier &&
        node.url &&
        !definitions.has(node.identifier)
      )
        definitions.set(node.identifier, node.url);
      if (title === undefined && node.type === "heading" && node.depth === 1)
        title = plainText(node).trim();
      for (const child of node.children ?? []) collect(child);
    };
    collect(root);
    const targets = new Set<string>();
    const visit = (node: MarkdownNode) => {
      if (
        ["code", "inlineCode", "html", "image", "imageReference", "definition"].includes(node.type)
      )
        return;
      if (node.type === "link" || node.type === "linkReference") {
        const href = node.url ?? definitions.get(node.identifier ?? "");
        const target = href === undefined ? undefined : resolveMemoryLink(file.path, href);
        if (target?.startsWith("knowledge/") && target !== file.path && !targets.has(target)) {
          targets.add(target);
          (paths.has(target) ? edges : brokenLinks).push({ source: file.path, target });
        }
      }
      for (const child of node.children ?? []) visit(child);
    };
    visit(root);
    const filename = file.path.slice(file.path.lastIndexOf("/") + 1);
    return {
      path: file.path,
      title: title || filename.replace(/\.md$/u, "") || filename,
      updatedAt: file.updatedAt,
    };
  });
  return { botId, nodes, edges, brokenLinks };
};
