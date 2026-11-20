// Copied from OpenMausBot, src/components/ExpandableText.test.ts, commit 738ec88472a3b888ff7b7793755d89da613ed301.
// Copyright 2026 Milind Soni and OpenMausBot contributors. Apache-2.0; see NOTICE.
// aut adaptation: boundary tests; the component DOM test covers disclosure.
import { describe, expect, it } from "vitest";

import { EXPANDABLE_TEXT_LIMIT, expandableTextIsLong } from "./ExpandableText.js";

describe("expandable question text", () => {
  it("leaves a short question alone", () => {
    expect(expandableTextIsLong("Which color?")).toBe(false);
  });

  it("treats a long question as expandable", () => {
    expect(expandableTextIsLong("x".repeat(EXPANDABLE_TEXT_LIMIT + 1))).toBe(true);
  });

  it("also folds a question longer than six lines", () => {
    expect(expandableTextIsLong(Array(6).fill("x").join("\n"))).toBe(false);
    expect(expandableTextIsLong(Array(7).fill("x").join("\n"))).toBe(true);
  });
});
