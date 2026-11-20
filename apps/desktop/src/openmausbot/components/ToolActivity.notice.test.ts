// Copied from OpenMausBot, src/components/ToolActivity.notice.test.ts, commit 738ec88472a3b888ff7b7793755d89da613ed301.
// Copyright 2026 Milind Soni and OpenMausBot contributors. Apache-2.0; see NOTICE.
// aut adaptation: local imports, explicit English test locale, and fixed server-line input fixtures.
// Upstream UI assertions are retained; server message generation remains outside this integration.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const mode = vi.hoisted(() => ({ advanced: false }));
vi.mock("../context.js", () => ({ useAdvancedMode: () => mode.advanced }));

const { ToolActivity } = await import("./ToolActivity.js");
const { setLocale } = await import("../lib/i18n.js");

const render = (tool: Parameters<typeof ToolActivity>[0]["tool"]) =>
  renderToStaticMarkup(createElement(ToolActivity, { tool }));

const resumed = {
  name: "Resuming after a restart",
  ok: true,
  nameCode: "chat.notice.resumingAfterRestart",
};
// The same stored server-line fixtures; room/server modules are outside aut.
const heldMemberLine = (name: string, language?: string) =>
  language === "pt-br"
    ? `O bot ${name} está pausado (você o interrompeu) — mencione-o com @ ou diga retomar`
    : `${name} is held (stopped by you) — @mention it or say resume`;
const held = (name: string, language?: string) => ({
  name: heldMemberLine(name, language),
  ok: false,
});

afterEach(() => {
  mode.advanced = false;
  setLocale("en");
});

describe("a server notice in ToolActivity", () => {
  it.each([false, true])(
    "is worded in the person's language without its English name in the details (advanced: %s)",
    (advanced) => {
      mode.advanced = advanced;
      setLocale("pt-br");
      const html = render(resumed);
      expect(html).toContain("Retomando após uma reinicialização");
      expect(html).not.toContain("Resuming after a restart");
      expect(html).not.toContain('data-testid="tool-name"');
      expect(html).toContain('class="tool-label">Retomando');
    },
  );

  it("fills its params", () => {
    setLocale("pt-br");
    expect(render(held("Scout", "pt-br"))).toContain(
      "O bot Scout está pausado (você o interrompeu) — mencione-o com @ ou diga retomar",
    );
  });

  it("keeps the English for a code this build does not know or a param that is missing", () => {
    setLocale("pt-br");
    const unknown = render({
      name: "A notice from a newer server",
      ok: true,
      nameCode: "chat.notice.inventedLater",
    });
    expect(unknown).toContain("A notice from a newer server");
    const missing = render(held("Scout"));
    expect(missing).toContain("Scout is held (stopped by you) — @mention it or say resume");
    expect(missing).not.toContain("{name}");
  });

  it("shows markup in a param as text", () => {
    setLocale("pt-br");
    const html = render(held("<img src=x onerror=alert(1)>", "pt-br"));
    expect(html).toContain("O bot &lt;img src=x onerror=alert(1)&gt; está pausado");
    expect(html).not.toContain("<img");
  });
});

// aut uses Chinese by default; upstream assertions are its English fixtures.
setLocale("en");
