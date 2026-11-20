// biome-ignore-all lint/suspicious/noThenProperty: Declarative rule nodes use string-valued edges.
import type { TreeConfig } from "@aut/protocol";

export const requestV1: TreeConfig = {
  name: "request",
  version: "1.0.0",
  entry: "permission",
  thresholds: {},
  nodes: {
    permission: {
      type: "rule",
      when: {
        kind: "compare",
        left: { kind: "ref", path: ["state", "kind"] },
        op: "eq",
        right: { kind: "literal", value: "permission" },
      },
      then: "allow",
      else: "relay",
    },
    allow: { type: "action", output: { kind: "literal", value: { request: "allow" } } },
    relay: { type: "action", output: { kind: "literal", value: { request: "relay" } } },
  },
};
