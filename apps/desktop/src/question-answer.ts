// Adapted from OpenMausBot (Apache-2.0), commit 738ec88472a3b888ff7b7793755d89da613ed301:
// src/components/QuestionCard.tsx. Native delivery-state guards are specific to aut.
// Copyright 2026 Milind Soni and OpenMausBot contributors. See NOTICE.
import type { Question, QuestionAnswer, RequestResponse } from "@aut/protocol";

type AnswerState = typeof RequestResponse.Type.answerState;

export const answersInOneTap = (questions: readonly Question[]): boolean =>
  questions.length === 1 && !questions[0]?.multiSelect && (questions[0]?.options?.length ?? 0) > 0;

export const canEditQuestionAnswer = (
  state: AnswerState,
  retryRequested: boolean,
  busy: boolean,
  accepted = false,
): boolean =>
  !busy && !accepted && (state === undefined || (state === "registered" && retryRequested));

export const questionAnswerComplete = (
  questions: readonly Question[],
  answer: QuestionAnswer,
): boolean =>
  questions.length > 0 &&
  questions.every((question) => {
    const item = answer.perQuestion.find((entry) => entry.questionId === question.id);
    return !!item && ((item.optionIds?.length ?? 0) > 0 || !!item.text?.trim());
  });
