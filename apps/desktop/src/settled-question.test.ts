// @vitest-environment happy-dom
import { type Card, RequestId, type RequestResponse, TaskId } from "@aut/protocol";
import { act, createElement } from "react";
import { describe, expect, it } from "vitest";
import { renderView } from "../test/render.js";
import { t } from "./i18n.js";
import { SettledQuestion } from "./settled-question.js";

const renders = new WeakMap<HTMLElement, ReturnType<typeof renderView>>();
function renderSettledQuestion(
  host: HTMLElement,
  card: Card,
  snapshot?: typeof RequestResponse.Type,
) {
  const next = createElement(SettledQuestion, { card, snapshot });
  const mounted = renders.get(host);
  if (mounted) mounted.update(next);
  else renders.set(host, renderView(next, host));
}

const requestId = RequestId.make("readback");
const card: Card = {
  id: "closed",
  requestId,
  state: "answered",
  prompt: "Original summary",
  options: [],
  allowFreeText: true,
  multiSelect: false,
};
const snapshot: typeof RequestResponse.Type = {
  request: {
    id: requestId,
    taskId: TaskId.make("task"),
    kind: "question",
    openedAt: 0,
    raw: null,
    questions: [
      {
        id: "first",
        text: "Pick a color",
        options: [{ id: "red-id", label: "Red" }],
        multiSelect: false,
        allowFreeText: false,
      },
      { id: "second", text: "Explain", multiSelect: false, allowFreeText: true },
    ],
  },
  answerState: "delivered",
  deliveredAnswer: {
    perQuestion: [
      { questionId: "second", text: "<em>literal</em>\nline two" },
      { questionId: "first", optionIds: ["red-id"] },
    ],
  },
};
const inputs = "button:not(.settled-details-toggle),input,textarea,select,form,[contenteditable]";
describe("read-only answer receipt", () => {
  it("pairs labels and literal free text with the right native prompt and only exposes disclosure", () => {
    const host = document.createElement("section");
    renderSettledQuestion(host, card, snapshot);
    expect(Array.from(host.querySelectorAll("dt,dd"), (e) => e.textContent)).toEqual([
      "Pick a color",
      "Red",
      "Explain",
      "<em>literal</em>\nline two",
    ]);
    expect(host.querySelector("em")).toBeNull();
    expect(host.querySelector(inputs)).toBeNull();
    expect(host.querySelector(".settled-summary")?.textContent).toBe(
      `${t.answered} · 问题 1：Red · 问题 2：<em>literal</em> line two`,
    );
    const toggle = host.querySelector<HTMLButtonElement>(".settled-question-line button");
    if (!toggle) throw new Error("Missing answer disclosure");
    expect(host.querySelector("dl")?.hidden).toBe(true);
    expect(toggle.textContent).toBe(t.answerDetails);
    act(() => toggle.click());
    expect(host.querySelector("dl")?.hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toBe(t.hideAnswerDetails);
    act(() => toggle.click());
    expect(host.querySelector("dl")?.hidden).toBe(true);
  });
  it("reveals the single confirmed answer without needing to expand anything", () => {
    const host = document.createElement("section");
    if (snapshot.request.kind !== "question") throw Error("fixture");
    renderSettledQuestion(host, card, {
      ...snapshot,
      request: { ...snapshot.request, questions: snapshot.request.questions.slice(0, 1) },
    });
    expect(host.textContent).toBe(`${t.youChose}Red`);
    expect(host.querySelector("dl,button")).toBeNull();
  });
  it("shows a flat, literal reply on the single free-text receipt", () => {
    if (snapshot.request.kind !== "question") throw Error("fixture");
    const host = document.createElement("section");
    renderSettledQuestion(host, card, {
      ...snapshot,
      request: { ...snapshot.request, questions: snapshot.request.questions.slice(1) },
    });
    expect(host.textContent).toBe(`${t.youAnswered}<em>literal</em> line two`);
    expect(host.querySelector("em,dl,button")).toBeNull();
  });
  it.each(["registered", "submitting", "indeterminate", "queued"] as const)(
    "never displays a value in state %s, even when given a stale value",
    (answerState) => {
      const host = document.createElement("section");
      renderSettledQuestion(host, card, snapshot);
      renderSettledQuestion(host, card, { ...snapshot, answerState });
      expect(host.textContent).toContain(t.readbackStatus[answerState]);
      expect(host.textContent).not.toContain("Red");
      expect(host.querySelector(`dl,details,${inputs}`)).toBeNull();
    },
  );
  it("remains status-only for absent, unclaimed, and unrelated responses", () => {
    const host = document.createElement("section");
    const { deliveredAnswer: _, ...unclaimed } = snapshot;
    for (const data of [
      undefined,
      unclaimed,
      { ...snapshot, request: { ...snapshot.request, id: RequestId.make("elsewhere") } },
    ]) {
      renderSettledQuestion(host, card, data);
      expect(host.textContent).toContain(card.prompt);
      if (data?.request.id !== card.requestId)
        expect(host.textContent).toContain(t.deliveryUnconfirmed);
      expect(host.querySelector(`dl,details,${inputs}`)).toBeNull();
    }
  });
});
