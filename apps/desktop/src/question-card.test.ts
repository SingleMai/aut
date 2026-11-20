import type { Question, QuestionAnswer } from "@aut/protocol";
import { describe, expect, it } from "vitest";
import {
  answersInOneTap,
  canEditQuestionAnswer,
  questionAnswerComplete,
} from "./question-answer.js";

const color: Question = {
  id: "color",
  text: "Choose a color",
  options: [{ id: "blue", label: "Blue" }],
  multiSelect: false,
  allowFreeText: true,
};
const notes: Question = { id: "notes", text: "Notes", multiSelect: false, allowFreeText: true };

describe("native question interaction", () => {
  it("allows one-tap answers only for one single-choice question", () => {
    expect(answersInOneTap([color])).toBe(true);
    expect(answersInOneTap([{ ...color, multiSelect: true }])).toBe(false);
    expect(answersInOneTap([color, notes])).toBe(false);
    expect(answersInOneTap([notes])).toBe(false);
    expect(answersInOneTap([])).toBe(false);
  });

  it("requires every question before submitting the whole group", () => {
    const partial: QuestionAnswer = {
      perQuestion: [{ questionId: color.id, optionIds: ["blue"] }],
    };
    expect(questionAnswerComplete([color, notes], partial)).toBe(false);
    expect(
      questionAnswerComplete([color, notes], {
        perQuestion: [...partial.perQuestion, { questionId: notes.id, text: "A free-text answer" }],
      }),
    ).toBe(true);
    expect(
      questionAnswerComplete([notes], { perQuestion: [{ questionId: notes.id, text: "  " }] }),
    ).toBe(false);
  });

  it("preserves uncertain delivery locks regardless of the retry flag", () => {
    expect(canEditQuestionAnswer(undefined, false, false)).toBe(true);
    expect(canEditQuestionAnswer(undefined, false, true)).toBe(false);
    expect(canEditQuestionAnswer("registered", false, false)).toBe(false);
    expect(canEditQuestionAnswer("registered", true, false)).toBe(true);
    expect(canEditQuestionAnswer("registered", true, true)).toBe(false);
    for (const state of ["submitting", "delivered", "indeterminate", "queued"] as const) {
      expect(canEditQuestionAnswer(state, false, false)).toBe(false);
      expect(canEditQuestionAnswer(state, true, false)).toBe(false);
    }
  });

  it("locks an HTTP-accepted answer before the durable claim is visible", () => {
    expect(canEditQuestionAnswer(undefined, false, false, true)).toBe(false);
    expect(canEditQuestionAnswer(undefined, true, false, true)).toBe(false);
    expect(canEditQuestionAnswer("registered", true, false, true)).toBe(false);
    expect(canEditQuestionAnswer("registered", true, false, false)).toBe(true);
  });
});
