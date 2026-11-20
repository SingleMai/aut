// Copied from OpenMausBot, src/components/ToolActivity.place.test.ts, commit 738ec88472a3b888ff7b7793755d89da613ed301.
// Copyright 2026 Milind Soni and OpenMausBot contributors. Apache-2.0; see NOTICE.
// aut adaptation: local imports and explicit English test locale; upstream assertions retained.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { setLocale } from "../lib/i18n.js";
import { ToolActivity } from "./ToolActivity.js";

describe("tool chip place icon", () => {
  it("shows the place a screen or page tool ran on, and nothing for other tools", () => {
    const browser = renderToStaticMarkup(
      createElement(ToolActivity, {
        tool: { name: "agent_browser_click", ok: true },
        place: "browser",
      }),
    );
    expect(browser).toContain('data-testid="tool-place"');
    expect(browser).toContain('aria-label="Browser"');
    const cloud = renderToStaticMarkup(
      createElement(ToolActivity, { tool: { name: "screenshot", ok: true }, place: "cloud" }),
    );
    expect(cloud).toContain('aria-label="Cloud desktop"');
    const shell = renderToStaticMarkup(
      createElement(ToolActivity, { tool: { name: "Bash", ok: true } }),
    );
    expect(shell).not.toContain('data-testid="tool-place"');
  });
});

// aut uses Chinese by default; upstream assertions are its English fixtures.
setLocale("en");
