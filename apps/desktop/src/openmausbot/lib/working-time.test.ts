// Copied from OpenMausBot (Apache-2.0), src/lib/working-time.test.ts.
// Commit: 738ec88472a3b888ff7b7793755d89da613ed301. Copyright 2026 Milind Soni and contributors.
// Original cases retained; imports, locale setup and strict-index assertions adapted. See NOTICE.
import { describe, expect, it } from "vitest";
import { formatElapsed } from "./working-time.js";

describe("formatElapsed", () => {
  it("counts whole seconds below a minute", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(999)).toBe("0s");
    expect(formatElapsed(42_000)).toBe("42s");
    expect(formatElapsed(59_999)).toBe("59s");
  });

  it("switches to zero-padded minutes at 60s", () => {
    expect(formatElapsed(60_000)).toBe("1m 00s");
    expect(formatElapsed(125_000)).toBe("2m 05s");
    expect(formatElapsed(3_600_000)).toBe("60m 00s");
  });

  it("clamps clock skew to zero instead of going negative", () => {
    expect(formatElapsed(-5_000)).toBe("0s");
  });
});
