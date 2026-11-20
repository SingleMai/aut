// biome-ignore-all lint/correctness/noChildrenProp: Retain the upstream createElement fixtures without changing their props.
// Copied from OpenMausBot, src/components/ToolActivity.simple.test.ts, commit 738ec88472a3b888ff7b7793755d89da613ed301.
// Copyright 2026 Milind Soni and OpenMausBot contributors. Apache-2.0; see NOTICE.
// aut adaptation: local imports and explicit English test locale; aut classes for the original content and layout roles.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../lib/i18n.js";

const mode = vi.hoisted(() => ({ advanced: false }));
vi.mock("../context.js", () => ({ useAdvancedMode: () => mode.advanced }));

const { ToolActivity } = await import("./ToolActivity.js");
const { ActivityRun } = await import("./ActivityRun.js");

const render = (tool: Parameters<typeof ToolActivity>[0]["tool"]) =>
  renderToStaticMarkup(createElement(ToolActivity, { tool }));

afterEach(() => {
  mode.advanced = false;
});

describe("ToolActivity in Simple mode", () => {
  it("names the step in plain words and keeps the tool's own name in the details", () => {
    const html = render({ name: "mcp__omb__computer_batch", ok: true, input: '{"actions":[]}' });
    expect(html).toContain("Use the screen · Completed · Tool details");
    expect(html).toMatch(/<span class="tool-label">Use the screen<\/span>/);
    expect(html).toContain('data-testid="tool-name"');
    expect(html).toContain("mcp__omb__computer_batch");
  });

  it("shows the line the harness wrote for an MCP server change, in both modes, with the tool's name in the details", () => {
    const tool = {
      name: "mcp__agents__mcp_server",
      label: "Added MCP server linear · Turned on · Test: needs sign-in",
      ok: true,
    };
    for (const advanced of [false, true]) {
      mode.advanced = advanced;
      const html = render(tool);
      expect(html, `advanced ${advanced}`).toContain(
        "Added MCP server linear · Turned on · Test: needs sign-in · Completed · Tool details",
      );
      expect(html, `advanced ${advanced}`).toMatch(
        /data-testid="tool-name">mcp__agents__mcp_server</,
      );
    }
  });

  it("says which MCP server failed and why on the row itself, whole, in both modes, with the tool's name in the details", () => {
    const problem =
      "mail needs you to sign in before its tools work. Open Apps → MCP servers and sign in to it.";
    for (const advanced of [false, true]) {
      mode.advanced = advanced;
      const html = render({
        name: "mcp__mail__search_threads",
        ok: false,
        problem,
        output: "Error dialing http://127.0.0.1:18080/b/REDACTED/mcp-mail",
      });
      expect(html, `advanced ${advanced}`).toContain(
        `<span class="tool-problem">${problem}</span>`,
      );
      expect(html, `advanced ${advanced}`).toMatch(
        /data-testid="tool-name">mcp__mail__search_threads</,
      );
    }
  });

  it("keeps the problem line off a step that did not fail", () => {
    expect(
      render({
        name: "mcp__mail__search_threads",
        ok: true,
        problem: "mail needs you to sign in.",
      }),
    ).not.toContain("mail needs you to sign in.");
  });

  it("keeps a command off the row, where it reads as a plain step", () => {
    const html = render({
      name: "Bash",
      ok: false,
      summary: "pnpm test --filter api",
      input: "pnpm test --filter api",
    });
    expect(html).toContain("Run a command · Failed · Tool details");
    expect(html).not.toContain('title="pnpm test --filter api"');
  });

  it("names a Composio slug by its action", () => {
    expect(render({ name: "GITHUB_GET_A_COMMIT", ok: true })).toContain("Get a commit · Completed");
  });
});

describe("ToolActivity in Advanced mode", () => {
  it("shows the tool name and command on the row, as before", () => {
    mode.advanced = true;
    const html = render({ name: "Bash", ok: true, summary: "pnpm test", input: "pnpm test" });
    expect(html).toContain("Bash · Completed · Tool details");
    expect(html).toMatch(/tool-name">Bash<\/span>/);
    expect(html).toContain('title="pnpm test"');
    expect(html).not.toContain('data-testid="tool-name"');
  });
});

describe("ActivityRun", () => {
  const steps = [
    {
      id: "a",
      at: 1,
      role: "bot" as const,
      kind: "activity" as const,
      tool: { name: "Bash", ok: true, summary: "ls" },
    },
    {
      id: "b",
      at: 2,
      role: "bot" as const,
      kind: "activity" as const,
      tool: { name: "ls -la /tmp", ok: true, summary: "ls -la /tmp" },
    },
    {
      id: "c",
      at: 3,
      role: "bot" as const,
      kind: "activity" as const,
      tool: { name: "mcp__omb__screenshot", ok: true },
    },
  ];

  it("sums a folded run up in plain words in Simple mode", () => {
    const html = renderToStaticMarkup(
      createElement(ActivityRun, { messages: steps, children: null }),
    );
    expect(html).toContain("3 steps · Run a command ×2, Look at the screen");
  });

  it("keeps the tool names in Advanced mode", () => {
    mode.advanced = true;
    const html = renderToStaticMarkup(
      createElement(ActivityRun, { messages: steps, children: null }),
    );
    expect(html).toContain("3 steps · Bash, ls -la /tmp, mcp__omb__screenshot");
  });
});

describe("ActivityRun at narrow widths", () => {
  it("lets the run's row shrink and truncate its summary instead of running off the screen", () => {
    const steps = [
      {
        id: "a",
        at: 1,
        role: "bot" as const,
        kind: "activity" as const,
        tool: { name: "Read", ok: true },
      },
      {
        id: "b",
        at: 2,
        role: "bot" as const,
        kind: "activity" as const,
        tool: { name: "mcp__omb__screenshot", ok: true },
      },
    ];
    const html = renderToStaticMarkup(
      createElement(ActivityRun, { messages: steps, children: null }),
    );
    expect(html).toMatch(/<button[^>]*class="tool-run-toggle"/);
    expect(html).toContain('class="tool-run-label"');
  });
});

// aut uses Chinese by default; upstream assertions are its English fixtures.
setLocale("en");
