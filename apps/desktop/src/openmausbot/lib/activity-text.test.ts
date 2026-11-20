// Copied from OpenMausBot (Apache-2.0), src/lib/activity-text.test.ts.
// Commit: 738ec88472a3b888ff7b7793755d89da613ed301. Copyright 2026 Milind Soni and contributors.
// Retained notice/routine formatting cases; unrelated server/store tests omitted. See NOTICE.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activityText, routineLineText } from "./activity-text.js";
import { setLocale } from "./i18n.js";

beforeEach(() => setLocale("en"));
afterEach(() => setLocale("en"));
describe("server notices", () => {
  const resets = {
    name: "error: This Claude account has reached its weekly limit, which resets Oct 22, 3:00 PM (UTC). Until then, switch this bot to another AI or Claude account.",
    nameCode: "chat.notice.claudeLimitResets",
    nameParams: {
      limit: "chat.notice.part.weeklyLimit",
      meanwhile: "chat.notice.part.switchAccount",
      resetsAt: Date.UTC(2026, 9, 22, 15),
      timeZone: "UTC",
    },
  };
  const english = resets.name.slice("error: ".length);

  it("word the parts they name and the moment they reset, in the reader's language", () => {
    setLocale("pt-br");
    expect(activityText(resets, english)).toBe(
      "Esta conta do Claude atingiu o limite semanal, que será renovado em 22 de out., 15:00 (UTC). Até lá, use outra IA ou outra conta do Claude para este bot.",
    );
    expect(
      activityText(
        {
          nameCode: "chat.notice.usageLimit",
          nameParams: { provider: "Grok", detail: ' (Grok says: "quota")' },
        },
        "x",
      ),
    ).toBe(
      'Esta conta de Grok atingiu o limite de uso (Grok says: "quota"). Espere o limite ser renovado ou troque a IA deste bot.',
    );
  });

  it("show the server's own English in English, and when a part or the zone cannot be worded", () => {
    expect(activityText(resets, english)).toBe(english);
    setLocale("pt-br");
    expect(
      activityText(
        { ...resets, nameParams: { ...resets.nameParams, timeZone: "Not/AZone" } },
        english,
      ),
    ).toBe(english);
    expect(
      activityText(
        {
          ...resets,
          nameParams: { ...resets.nameParams, limit: "chat.notice.part.inventedLater" },
        },
        english,
      ),
    ).toBe(english);
  });
});
describe("a routine's fixed lines", () => {
  it("are worded by their code, and only a routines.server code", () => {
    expect(routineLineText("routines.server.nothingNew", "Nothing new since the last check")).toBe(
      "Nothing new since the last check",
    );
    setLocale("pt-br");
    expect(routineLineText("routines.server.nothingNew", "Nothing new since the last check")).toBe(
      "Nada novo desde a última verificação",
    );
    expect(routineLineText("chat.notice.resumingAfterRestart", "x")).toBe("x");
    expect(routineLineText(undefined, "x")).toBe("x");
  });
});

describe("a routine run's coded error and attention", () => {
  it.each([
    ["stalled", "the AI stalled", "um travamento da IA"],
    ["rateLimited", "a rate limit", "atingir um limite de requisições"],
    ["provider", "a temporary error", "um erro temporário"],
    ["failed", "a failure", "um problema"],
  ])("composes the %s retry reason as a complete sentence", (part, english, portuguese) => {
    setLocale("pt-br");
    expect(
      routineLineText(
        "routines.server.retryAfter",
        `Starting again shortly after ${english}: 429`,
        { why: `routines.server.part.${part}`, failure: "429" },
      ),
    ).toBe(`Vai começar novamente em instantes, depois de ${portuguese}. Detalhe: 429`);
  });

  const limitWait =
    "Waiting for the AI's usage limit to reset; this run starts again at Oct 22, 3:00 PM (UTC)";
  const params = {
    resets: "Oct 22, 3:00 PM (UTC)",
    resetsAt: Date.UTC(2026, 9, 22, 15),
    timeZone: "UTC",
  };

  it("words parts and moments, and only while the field still reads as the line's English", () => {
    setLocale("pt-br");
    expect(routineLineText("routines.server.limitWait", limitWait, params)).toBe(
      "Esperando a renovação do limite de uso da IA. Esta execução começa novamente em 22 de out., 15:00 (UTC)",
    );
    expect(
      routineLineText(
        "routines.server.retryAfter",
        "Starting again shortly after a rate limit: 429",
        { why: "routines.server.part.rateLimited", failure: "429" },
      ),
    ).toBe(
      "Vai começar novamente em instantes, depois de atingir um limite de requisições. Detalhe: 429",
    );
    expect(
      routineLineText(
        "routines.server.limitWait",
        "The routine was paused before this run started",
        params,
      ),
    ).toBe("The routine was paused before this run started");
    expect(routineLineText("settings.title", "Settings")).toBe("Settings");
  });
});
