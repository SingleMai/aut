// @vitest-environment happy-dom
import {
  type Card,
  MessageId,
  type Question,
  type QuestionAnswer,
  RequestId,
  type RequestResponse,
  TaskId,
} from "@aut/protocol";
import { Effect } from "effect";
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderView } from "../test/render.js";
import { desktopApi, UiError } from "./api.js";
import { ConversationMessage } from "./conversation-message.js";
import { createDesktopData } from "./desktop-data.js";
import { setLocale } from "./openmausbot/lib/i18n.js";
import { QuestionCard } from "./question-card.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
type PendingResponse = typeof RequestResponse.Type;

const card: Card = {
  id: "question-card",
  prompt: "Original native question",
  requestId: RequestId.make("request"),
  multiSelect: false,
  allowFreeText: true,
  state: "open",
  options: [],
};
const question = (overrides: Partial<Question> = {}): Question => ({
  id: "question",
  text: "Long native question. ".repeat(20),
  options: [
    { id: "yes", label: "Yes" },
    { id: "no", label: "No" },
  ],
  multiSelect: false,
  allowFreeText: true,
  ...overrides,
});
const response = (
  questions: readonly Question[],
  answerState?: PendingResponse["answerState"],
): PendingResponse => ({
  request: {
    id: RequestId.make("request"),
    taskId: TaskId.make("task"),
    kind: "question",
    questions,
    openedAt: 1,
    raw: null,
  },
  ...(answerState ? { answerState } : {}),
});

const onAnswer = vi.fn<(answer: QuestionAnswer) => Effect.Effect<void, UiError>>(() => Effect.void);

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Expected question control is missing");
  return value;
}

const mount = (questions: readonly Question[], answerState?: PendingResponse["answerState"]) => {
  const element = (snapshot: PendingResponse) =>
    createElement(QuestionCard, {
      card,
      snapshot,
      onAnswer,
      onError: vi.fn(),
    });
  const mounted = renderView(element(response(questions, answerState)));
  return {
    element: mounted.element,
    update: (snapshot: PendingResponse) => mounted.update(element(snapshot)),
  };
};

beforeEach(() => {
  setLocale("zh");
  onAnswer.mockClear();
});
afterEach(() => vi.restoreAllMocks());
describe("native question cards with the copied ExpandableText", () => {
  it("moves keyboard focus without submitting and identifies choices with identical labels by ID", async () => {
    const view = mount([
      question({
        options: [
          { id: "first", label: "Same" },
          { id: "second", label: "Same" },
        ],
      }),
    ]);
    const first = required(
      view.element.querySelector<HTMLButtonElement>('[data-ask-choice="first"]'),
    );
    const second = required(
      view.element.querySelector<HTMLButtonElement>('[data-ask-choice="second"]'),
    );
    first.focus();
    const arrow = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      first.dispatchEvent(arrow);
    });
    expect(arrow.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(second);
    expect(second.getAttribute("aria-checked")).toBe("false");
    expect(onAnswer).not.toHaveBeenCalled();
    await act(async () => second.click());
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith({
      perQuestion: [{ questionId: "question", optionIds: ["second"] }],
    });
  });

  it("locks an accepted answer when the subsequent daemon refresh fails", async () => {
    const data = createDesktopData();
    const error = new UiError({ message: "Read interrupted" });
    vi.spyOn(data, "refresh").mockReturnValue(Effect.fail(error));
    vi.spyOn(desktopApi, "getRequest").mockReturnValue(Effect.succeed(response([question()])));
    const send = vi
      .spyOn(desktopApi, "sendAction")
      .mockReturnValue(Effect.succeed({ accepted: true }));
    const flash = vi.fn();
    const view = renderView(
      createElement(ConversationMessage, {
        message: {
          id: MessageId.make("m1"),
          at: 1,
          author: "chief",
          kind: "question-card",
          text: card.prompt,
          card,
        },
        layout: { showTime: false, showAuthor: true, joinedAbove: false, joinedBelow: false },
        source: "chief",
        typedPast: false,
        revision: 0,
        data,
        flash,
        onQuote: vi.fn(),
        openTask: vi.fn(),
        showReport: vi.fn(),
        focusComposer: vi.fn(),
      }),
    );
    await act(async () => {
      await vi.waitFor(() => expect(desktopApi.getRequest).toHaveBeenCalled());
    });
    const choice = required(
      view.element.querySelector<HTMLButtonElement>('[data-ask-choice="yes"]'),
    );
    await act(async () => choice.click());
    expect(flash).toHaveBeenCalledWith(expect.stringContaining(error.message));
    expect(view.element.querySelector("fieldset")?.disabled).toBe(true);
    expect(view.element.querySelector(".avatar svg")?.getAttribute("data-expression")).toBe(
      "question",
    );
    await act(async () => choice.click());
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("acknowledges only a live native delivery and restores a quiet avatar when reading history", async () => {
    const get = vi.spyOn(desktopApi, "getRequest");
    const data = createDesktopData();
    const props = {
      message: {
        id: MessageId.make("native-question"),
        at: 1,
        author: "chief",
        kind: "question-card",
        text: card.prompt,
        card,
      },
      layout: { showTime: false, showAuthor: true, joinedAbove: false, joinedBelow: false },
      source: "aut",
      typedPast: false,
      data,
      flash: vi.fn(),
      onQuote: vi.fn(),
      openTask: vi.fn(),
      showReport: vi.fn(),
      focusComposer: vi.fn(),
    } as const;
    const element = (revision: number) =>
      createElement(ConversationMessage, { ...props, revision });
    get.mockReturnValue(Effect.succeed(response([question()])));
    const view = renderView(element(0));
    const face = () => view.element.querySelector(".avatar svg")?.getAttribute("data-expression");
    for (const [i, state] of (
      ["registered", "submitting", "indeterminate", "delivered"] as const
    ).entries()) {
      get.mockReturnValue(Effect.succeed(response([question()], state)));
      await act(async () => view.update(element(i + 1)));
      expect(face()).toBe(state === "delivered" ? "received" : "question");
    }
    view.dispose();
    let history = renderView(element(0));
    await act(async () => {});
    expect(history.element.querySelector(".avatar svg")?.getAttribute("data-expression")).toBe(
      "idle",
    );
    history.dispose();
    get.mockReturnValue(Effect.succeed(response([question()], "queued")));
    history = renderView(element(0));
    await act(async () => {});
    expect(history.element.querySelector(".avatar svg")?.getAttribute("data-expression")).toBe(
      "idle",
    );
  });

  it("retries the same radio after rejection and locks the accepted answer", async () => {
    onAnswer.mockImplementationOnce(() =>
      Effect.fail(new UiError({ message: "Temporary failure" })),
    );
    const view = mount([question({ text: "Choose one" })]);
    const radio = required(
      view.element.querySelector<HTMLButtonElement>('[data-ask-choice="yes"]'),
    );
    await act(async () => radio.click());
    expect(view.element.querySelector(".question-error")?.textContent).toBe("Temporary failure");
    await act(async () => radio.click());
    expect(onAnswer).toHaveBeenCalledTimes(2);
    expect(onAnswer).toHaveBeenLastCalledWith({
      perQuestion: [{ questionId: "question", optionIds: ["yes"] }],
    });
    expect(view.element.querySelector("fieldset")?.disabled).toBe(true);
  });

  it("submits a multi-question group only after explicit confirmation", async () => {
    const view = mount([
      question({ text: "Choose one" }),
      question({ id: "next", text: "Explain", options: [] }),
    ]);
    const radio = required(view.element.querySelector<HTMLButtonElement>('[data-ask-choice="no"]'));
    act(() => radio.click());
    const input = required(
      view.element.querySelector<HTMLTextAreaElement>("[data-active-question] textarea"),
    );
    expect(document.activeElement).toBe(input);
    act(() => {
      input.value = "Details";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onAnswer).not.toHaveBeenCalled();
    await act(async () =>
      required(view.element.querySelector<HTMLButtonElement>('button[type="submit"]')).click(),
    );
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith({
      perQuestion: [
        { questionId: "question", optionIds: ["no"] },
        { questionId: "next", optionIds: [], text: "Details" },
      ],
    });
  });

  it("uses the original four-line collapsed state and preserves the full question when toggled", () => {
    const asked = question();
    const { element } = mount([asked]);
    const copy = required(element.querySelector(".question-copy"));
    const toggle = required(copy.querySelector<HTMLButtonElement>("button"));
    expect(element.querySelector("h3")?.textContent).toBe("需要你回答");
    expect(copy.textContent).toContain(asked.text);
    expect(copy.querySelector(".expandable-text")?.textContent).toBe(asked.text);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toBe("显示完整问题");
    act(() => toggle.click());
    expect(copy.querySelector(".expandable-text")?.textContent).toBe(asked.text);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toBe("收起");
    act(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("keeps short single questions in their title and does not add an unnecessary toggle", () => {
    const asked = question({ text: "Choose a color" });
    const { element } = mount([asked]);
    expect(element.querySelector("h3")?.textContent).toBe(asked.text);
    expect(element.querySelector(".question-copy")).toBeNull();
    expect(element.querySelectorAll('[role="radio"]')).toHaveLength(2);
  });

  it("preserves native choices and custom text across collapse and response refresh", () => {
    const asked = question({ multiSelect: true });
    const view = mount([asked]);
    const input = required(
      view.element.querySelector<HTMLButtonElement>('[data-ask-choice="yes"]'),
    );
    const custom = required(view.element.querySelector<HTMLTextAreaElement>("textarea"));
    act(() => input.click());
    custom.value = "Keep this exact draft\nwith its second line";
    act(() => {
      custom.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const toggle = required(view.element.querySelector<HTMLButtonElement>(".question-copy button"));
    act(() => toggle.click());
    view.update(response([asked]));
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(input.getAttribute("aria-checked")).toBe("true");
    expect(custom.value).toBe("Keep this exact draft\nwith its second line");
    act(() => toggle.click());
    expect(input.getAttribute("aria-checked")).toBe("true");
    expect(custom.value).toBe("Keep this exact draft\nwith its second line");
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("keeps each question's reading state when the user changes tabs", () => {
    const first = question();
    const second = question({ id: "second", text: "Second long question. ".repeat(20) });
    const view = mount([first, second]);
    const copies = [...view.element.querySelectorAll<HTMLElement>(".question-copy")];
    const firstToggle = required(copies[0]?.querySelector<HTMLButtonElement>("button"));
    act(() => firstToggle.click());
    act(() =>
      required(view.element.querySelector<HTMLButtonElement>('[data-ask-choice="yes"]')).click(),
    );
    expect(copies[0]?.closest<HTMLElement>('[role="tabpanel"]')?.hidden).toBe(true);
    expect(copies[1]?.closest<HTMLElement>('[role="tabpanel"]')?.hidden).toBe(false);
    act(() => {
      required(view.element.querySelector<HTMLButtonElement>('[role="tab"]')).dispatchEvent(
        new MouseEvent("mousedown", { button: 0, bubbles: true }),
      );
    });
    expect(copies[0]?.closest<HTMLElement>('[role="tabpanel"]')?.hidden).toBe(false);
    expect(copies[1]?.closest<HTMLElement>('[role="tabpanel"]')?.hidden).toBe(true);
    expect(firstToggle.getAttribute("aria-expanded")).toBe("true");
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("still allows reading the full question while indeterminate delivery locks answer controls", () => {
    const { element } = mount([question()], "indeterminate");
    expect(element.querySelector("fieldset")?.disabled).toBe(true);
    const toggle = required(element.querySelector<HTMLButtonElement>(".question-copy button"));
    expect(toggle.closest("fieldset")).toBeNull();
    act(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(onAnswer).not.toHaveBeenCalled();
    expect(element.querySelector("fieldset")?.disabled).toBe(true);
  });
});
