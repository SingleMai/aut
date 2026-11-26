import {
  makeAcpAdapter,
  makeClaudeAdapter,
  makeCodexAdapter,
  readAcpModels,
  readClaudeModels,
  readCodexDefaults,
  readCodexModels,
} from "@aut/adapters";
import type {
  AdapterError,
  BotModelDiscoveryInput,
  BotModelsResponse,
  HarnessAdapter,
  HarnessInstanceConfig,
  ModelSelection,
} from "@aut/protocol";
import type { Effect } from "effect";

export type DefaultsDiscoveryInput = BotModelDiscoveryInput & { readonly timeoutMs: number };
export type DiscoveredDefaults = Pick<ModelSelection, "model" | "effort">;

interface Registration {
  readonly verification: "verified" | "preview";
  readonly create: (config: HarnessInstanceConfig) => HarnessAdapter;
  readonly models: (
    input: BotModelDiscoveryInput,
  ) => Effect.Effect<BotModelsResponse, AdapterError>;
  readonly defaults?: (
    input: DefaultsDiscoveryInput,
  ) => Effect.Effect<DiscoveredDefaults, AdapterError>;
  readonly presets: readonly {
    readonly instance: HarnessInstanceConfig;
    readonly verification: "verified" | "preview";
  }[];
}

/** Session creation and Bot model choices share the same supported adapters. */
export const harnessRegistry: Readonly<Record<string, Registration>> = {
  codex: {
    verification: "verified",
    create: (config) => makeCodexAdapter(config),
    models: ({ instance, cwd }) => readCodexModels({ ...instance, cwd }),
    defaults: ({ instance, cwd, timeoutMs }) => readCodexDefaults({ ...instance, cwd, timeoutMs }),
    presets: [
      {
        instance: { id: "builtin:codex", name: "Codex", kind: "codex", command: "codex", args: [] },
        verification: "verified",
      },
    ],
  },
  claude: {
    verification: "verified",
    create: (config) => makeClaudeAdapter(config),
    models: ({ instance, cwd }) => readClaudeModels({ ...instance, cwd }),
    presets: [
      {
        instance: {
          id: "builtin:claude",
          name: "Claude Code",
          kind: "claude",
          command: "claude",
          args: [],
        },
        verification: "verified",
      },
    ],
  },
  acp: {
    verification: "preview",
    create: (config) => makeAcpAdapter(config),
    models: ({ instance, cwd }) => readAcpModels({ ...instance, cwd }),
    presets: [
      {
        instance: {
          id: "builtin:opencode",
          name: "OpenCode",
          kind: "acp",
          command: "opencode",
          args: ["acp"],
        },
        verification: "verified",
      },
      {
        instance: {
          id: "builtin:grok",
          name: "Grok",
          kind: "acp",
          command: "grok",
          args: ["agent", "stdio"],
        },
        verification: "preview",
      },
    ],
  },
};

export const harnessRegistration = (kind: string) =>
  Object.hasOwn(harnessRegistry, kind) ? harnessRegistry[kind] : undefined;
