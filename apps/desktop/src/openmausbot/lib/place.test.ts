// Copied from OpenMausBot (Apache-2.0), src/lib/place.test.ts.
// Commit: 738ec88472a3b888ff7b7793755d89da613ed301. Copyright 2026 Milind Soni and contributors.
// Place-label and tool-surface test blocks copied; unrelated app/store selection tests omitted. See NOTICE.
import { describe, expect, it } from "vitest";
import { toolSurfaceKind } from "../shared/tool-surface.js";
import { isComputerPlace, placeLabelKey, toolPlace } from "./place.js";

describe("where a conversation works", () => {
  it("names places with one label key each", () => {
    expect(placeLabelKey("cloud")).toBe("place.cloud");
    expect(placeLabelKey("auto")).toBe("place.auto");
    expect(isComputerPlace("vm")).toBe(true);
    expect(isComputerPlace("browser")).toBe(false);
    expect(isComputerPlace("auto")).toBe(false);
  });

  it("gives browser tools the browser, computer tools the conversation's computer, and other tools nothing", () => {
    expect(toolPlace("agent_browser_snapshot", "cloud")).toBe("browser");
    expect(toolPlace("mcp__browser__browser_click", "vm")).toBe("browser");
    expect(toolPlace("mcp__computer__screenshot", "cloud")).toBe("cloud");
    expect(toolPlace("click", "local")).toBe("local");
    expect(toolPlace("computer_exec", "vm")).toBe("vm");
    expect(toolPlace("browser_click", "cloud")).toBe("cloud");
    expect(toolPlace("screenshot", "auto")).toBeNull();
    expect(toolPlace("screenshot", "browser")).toBeNull();
    for (const name of [
      "Bash",
      "Read",
      "list_bots",
      "recall",
      "propose_routine",
      "mcp__agents__ask_bot",
    ]) {
      expect(toolPlace(name, "cloud"), name).toBeNull();
    }
  });

  it("classifies tool names without guessing computer for unrelated tools", () => {
    expect(toolSurfaceKind("agent_browser_open")).toBe("browser");
    expect(toolSurfaceKind("browser__snapshot")).toBe("browser");
    expect(toolSurfaceKind("computer__click")).toBe("computer");
    expect(toolSurfaceKind("hotkey")).toBe("computer");
    expect(toolSurfaceKind("Bash")).toBeNull();
    expect(toolSurfaceKind("mcp__agents__list_bots")).toBeNull();
  });
});
