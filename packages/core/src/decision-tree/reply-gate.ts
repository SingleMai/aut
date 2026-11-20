// biome-ignore-all lint/suspicious/noThenProperty: Declarative rule nodes use the protocol's string-valued then edge.
import type { TreeConfig } from "@aut/protocol";

export const replyGateV1: TreeConfig = {
  name: "reply-gate",
  version: "1.0.0",
  entry: "length",
  thresholds: { characters: 200, words: 120, readability: 0.6, rewrites: 2 },
  nodes: {
    length: {
      type: "rule",
      when: {
        kind: "all",
        predicates: [
          {
            kind: "compare",
            left: { kind: "ref", path: ["state", "characters"] },
            op: "gt",
            right: { kind: "literal", value: 0 },
          },
          {
            kind: "any",
            predicates: [
              {
                kind: "all",
                predicates: [
                  {
                    kind: "compare",
                    left: { kind: "ref", path: ["state", "hasHan"] },
                    op: "eq",
                    right: { kind: "literal", value: true },
                  },
                  {
                    kind: "compare",
                    left: { kind: "ref", path: ["state", "characters"] },
                    op: "lte",
                    right: { kind: "ref", path: ["thresholds", "characters"] },
                  },
                ],
              },
              {
                kind: "all",
                predicates: [
                  {
                    kind: "compare",
                    left: { kind: "ref", path: ["state", "hasHan"] },
                    op: "eq",
                    right: { kind: "literal", value: false },
                  },
                  {
                    kind: "compare",
                    left: { kind: "ref", path: ["state", "words"] },
                    op: "lte",
                    right: { kind: "ref", path: ["thresholds", "words"] },
                  },
                ],
              },
            ],
          },
        ],
      },
      then: "readability",
      else: "budget",
    },
    readability: {
      type: "classify",
      state: { kind: "object", fields: { report: { kind: "ref", path: ["state", "report"] } } },
      questions: [
        {
          id: { kind: "literal", value: "readable" },
          question: {
            type: "noul",
            instructions:
              "Is this reply concise and understandable for a non-technical user, without unexplained jargon, logs or code dumps?",
          },
        },
      ],
      next: "readable",
      onError: "budget",
    },
    readable: {
      type: "rule",
      when: {
        kind: "compare",
        left: { kind: "ref", path: ["answers", "readable", "noul"] },
        op: "gte",
        right: { kind: "ref", path: ["thresholds", "readability"] },
      },
      then: "deliver",
      else: "budget",
    },
    budget: {
      type: "rule",
      when: {
        kind: "compare",
        left: { kind: "ref", path: ["state", "rewrites"] },
        op: "lt",
        right: { kind: "ref", path: ["thresholds", "rewrites"] },
      },
      then: "rewrite",
      else: "truncate",
    },
    rewrite: {
      type: "rewrite",
      instructions:
        "Rewrite the report as a reply to the user: at most 200 Chinese characters or 120 English words, plain language, conclusions first, no logs or code. Preserve the meaning and uncertainty. Return only the rewritten report. Do not perform additional work or ask questions.",
      next: "length",
      onError: "truncate",
    },
    deliver: { type: "action", output: { kind: "literal", value: { gate: "deliver" } } },
    truncate: { type: "action", output: { kind: "literal", value: { gate: "truncate" } } },
  },
};
