import type { MemoryFileEntry, MemoryGraphResponse } from "@aut/protocol";
import { Button, TextField } from "@radix-ui/themes";
import { useId, useMemo, useState } from "react";
import { t } from "./i18n.js";

const GRAPH_LIMIT = 24;
const WIDTH = 640;
export const memoryFileName = (path: string) =>
  path.split("/").at(-1)?.replace(/\.md$/u, "") ?? path;
type GraphNode = MemoryGraphResponse["nodes"][number];

/** A deterministic layout avoids moving documents between refreshes. */
function positions(
  nodes: readonly GraphNode[],
  edges: MemoryGraphResponse["edges"],
  height: number,
) {
  const points = nodes.map((node, index) => {
    const angle = index * 2.399963229728653;
    const radius = 55 * Math.sqrt(index);
    return {
      ...node,
      x: WIDTH / 2 + Math.cos(angle) * radius,
      y: height / 2 + Math.sin(angle) * radius,
    };
  });
  const lookup = new Map(points.map((point) => [point.path, point]));
  for (let step = 0; step < 150; step++) {
    const motion = new Map(points.map((point) => [point.path, { x: 0, y: 0 }]));
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      if (!a) continue;
      const da = motion.get(a.path);
      if (!da) continue;
      da.x += (WIDTH / 2 - a.x) * 0.003;
      da.y += (height / 2 - a.y) * 0.003;
      for (const b of points.slice(i + 1)) {
        const db = motion.get(b.path);
        if (!db) continue;
        const dx = a.x - b.x || 0.1;
        const dy = a.y - b.y || 0.1;
        const distance = Math.max(1, Math.hypot(dx, dy));
        const force = 1600 / (distance * distance) + Math.max(0, 142 - distance) * 0.065;
        da.x += (dx / distance) * force;
        da.y += (dy / distance) * force;
        db.x -= (dx / distance) * force;
        db.y -= (dy / distance) * force;
      }
    }
    for (const edge of edges) {
      const a = lookup.get(edge.source),
        b = lookup.get(edge.target);
      const da = motion.get(edge.source),
        db = motion.get(edge.target);
      if (!a || !b || !da || !db || a === b) continue;
      const dx = b.x - a.x,
        dy = b.y - a.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const force = (distance - 165) * 0.009;
      da.x += (dx / distance) * force;
      da.y += (dy / distance) * force;
      db.x -= (dx / distance) * force;
      db.y -= (dy / distance) * force;
    }
    for (const point of points) {
      const delta = motion.get(point.path);
      if (!delta) continue;
      point.x = Math.max(72, Math.min(WIDTH - 72, point.x + Math.max(-7, Math.min(7, delta.x))));
      point.y = Math.max(48, Math.min(height - 65, point.y + Math.max(-7, Math.min(7, delta.y))));
    }
  }
  return points;
}

function GraphCanvas({
  graph,
  nodes,
  selected,
  disabled,
  select,
}: {
  graph: MemoryGraphResponse;
  nodes: readonly GraphNode[];
  selected: string | undefined;
  disabled: boolean;
  select: (path: string) => void;
}) {
  const arrowId = useId();
  const height = Math.max(360, Math.ceil(nodes.length / 4) * 105);
  const points = useMemo(() => positions(nodes, graph.edges, height), [nodes, graph.edges, height]);
  const lookup = new Map(points.map((point) => [point.path, point]));
  const related = new Set([selected]);
  for (const edge of graph.edges) {
    if (edge.source === selected) related.add(edge.target);
    if (edge.target === selected) related.add(edge.source);
  }
  return (
    <section className="memory-graph-scroll" aria-label={t.memoryGraph}>
      <div className="memory-graph-canvas" style={{ height }}>
        <svg
          viewBox={`0 0 ${WIDTH} ${height}`}
          preserveAspectRatio="none"
          aria-hidden="true"
          className="memory-graph-lines"
        >
          <defs>
            <marker
              id={arrowId}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="5"
              markerHeight="5"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
            </marker>
          </defs>
          {graph.edges.map((edge) => {
            const a = lookup.get(edge.source),
              b = lookup.get(edge.target);
            if (!a || !b || a === b) return null;
            const length = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
            const offsetX = ((b.x - a.x) / length) * 13;
            const offsetY = ((b.y - a.y) / length) * 13;
            return (
              <line
                key={`${edge.source}\0${edge.target}`}
                x1={a.x + offsetX}
                y1={a.y + offsetY}
                x2={b.x - offsetX}
                y2={b.y - offsetY}
                data-highlighted={selected === edge.source || selected === edge.target || undefined}
                data-muted={
                  (selected && selected !== edge.source && selected !== edge.target) || undefined
                }
                markerEnd={`url(#${arrowId})`}
              />
            );
          })}
        </svg>
        {points.map((node) => (
          <button
            type="button"
            key={node.path}
            className="memory-graph-node"
            style={{ left: `${(node.x / WIDTH) * 100}%`, top: node.y }}
            title={`${node.title}\n${node.path}`}
            aria-label={t.memoryOpenDocument(node.title)}
            aria-pressed={selected === node.path}
            data-muted={(selected && !related.has(node.path)) || undefined}
            disabled={disabled}
            onClick={() => select(node.path)}
          >
            <span className="memory-graph-dot" />
            <span className="memory-graph-label">{node.title}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

export function MemoryKnowledge({
  graph,
  status,
  files,
  selected,
  disabled,
  select,
  retry,
}: {
  graph: MemoryGraphResponse | undefined;
  status: "loading" | "ready" | "failed";
  files: readonly MemoryFileEntry[];
  selected: string | undefined;
  disabled: boolean;
  select: (path: string) => void;
  retry: () => void;
}) {
  const [view, setView] = useState<"graph" | "list">("graph");
  const [query, setQuery] = useState("");
  const nodes =
    graph?.nodes ??
    files
      .filter((file) => file.path.startsWith("knowledge/"))
      .map((file) => ({ ...file, title: memoryFileName(file.path) }));
  const matching = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return nodes.filter(
      (node) => !term || `${node.title}\n${node.path}`.toLocaleLowerCase().includes(term),
    );
  }, [nodes, query]);
  const local = !query.trim() && selected !== undefined && matching.length > GRAPH_LIMIT;
  const candidates = useMemo(() => {
    if (!local || !graph) return matching;
    const neighbors = new Set([selected]);
    for (const edge of graph.edges) {
      if (edge.source === selected) neighbors.add(edge.target);
      if (edge.target === selected) neighbors.add(edge.source);
    }
    return matching.filter((node) => neighbors.has(node.path));
  }, [matching, local, graph, selected]);
  const visible = useMemo(() => {
    if (candidates.length <= GRAPH_LIMIT) return candidates;
    const focus = candidates.find((node) => node.path === selected);
    const ordered = focus ? [focus, ...candidates.filter((node) => node !== focus)] : candidates;
    return ordered.slice(0, GRAPH_LIMIT);
  }, [candidates, selected]);
  return (
    <section className="memory-knowledge" aria-label={t.memoryKnowledge}>
      <div className="memory-browser-toolbar">
        <TextField.Root
          aria-label={t.memorySearchKnowledge}
          placeholder={t.memorySearchKnowledge}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <fieldset className="memory-view-switch" aria-label={t.memoryKnowledgeView}>
          <button type="button" aria-pressed={view === "graph"} onClick={() => setView("graph")}>
            {t.memoryGraph}
          </button>
          <button type="button" aria-pressed={view === "list"} onClick={() => setView("list")}>
            {t.memoryList}
          </button>
        </fieldset>
      </div>
      {status === "loading" && (
        <p role="status" className="memory-browser-message muted">
          {t.loading}
        </p>
      )}
      {status === "failed" && (
        <div role="alert" className="memory-browser-message">
          <p>{t.memoryGraphFailed}</p>
          <Button size="1" variant="soft" onClick={retry}>
            {t.retry}
          </Button>
        </div>
      )}
      {(status === "ready" || view === "list") &&
        (nodes.length === 0 ? (
          <div className="memory-empty-state">
            <strong>{t.memoryKnowledgeEmpty}</strong>
            <p>{t.memoryKnowledgeEmptyHint}</p>
          </div>
        ) : matching.length === 0 ? (
          <p className="memory-browser-message muted">{t.memorySearchEmpty}</p>
        ) : view === "list" ? (
          <nav className="memory-document-list" aria-label={t.memoryKnowledge}>
            {matching.map((node) => (
              <button
                key={node.path}
                type="button"
                className="memory-file"
                title={node.path}
                disabled={disabled}
                aria-current={node.path === selected ? "page" : undefined}
                onClick={() => select(node.path)}
              >
                <strong>{node.title}</strong>
                <span>{node.path.slice("knowledge/".length)}</span>
              </button>
            ))}
          </nav>
        ) : (
          graph && (
            <>
              <GraphCanvas
                graph={graph}
                nodes={visible}
                selected={visible.some((node) => node.path === selected) ? selected : undefined}
                disabled={disabled}
                select={select}
              />
              <div className="memory-graph-caption">
                <span>{t.memoryGraphCount(nodes.length, graph.edges.length)}</span>
                {local ? <span>{t.memoryGraphLocal}</span> : null}
                {candidates.length > visible.length && (
                  <span>{t.memoryGraphLimited(visible.length)}</span>
                )}
                {graph.edges.length === 0 && <span>{t.memoryGraphNoLinks}</span>}
              </div>
            </>
          )
        ))}
    </section>
  );
}
