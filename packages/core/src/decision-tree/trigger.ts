import type { TreeConfig } from "@aut/protocol";

const ref = (...path: string[]) => ({ kind: "ref", path }) as const;

/** Trigger routing has no classifier node. Its fixed target is still a data tree output. */
export const triggerV1: TreeConfig = {
  name: "trigger",
  version: "1.0.0",
  entry: "new-trigger",
  thresholds: {},
  nodes: {
    "new-trigger": {
      type: "action",
      output: ref("state", "selectedOp"),
    },
  },
};
