import { Schema } from "effect";

const Name = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(80));
export const RemoteToken = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/));
export const RemoteId = Schema.String.pipe(Schema.pattern(/^[a-zA-Z0-9_-]{1,128}$/));
export const RemotePort = Schema.Int.pipe(Schema.between(1, 65535));
export const TailscaleLoginUrl = Schema.String.pipe(
  Schema.maxLength(4096),
  Schema.pattern(/^https:\/\/login\.tailscale\.com\/[^\s]*$/),
);
export const RemoteConnectionInfo = Schema.Struct({
  version: Schema.Literal(1),
  hostId: RemoteId,
  name: Name,
  nodeId: RemoteId,
  token: RemoteToken,
});
export type RemoteConnectionInfo = typeof RemoteConnectionInfo.Type;
export const RemoteHostConfig = Schema.Struct({
  id: RemoteId,
  name: Name,
  enabled: Schema.Boolean,
});
export type RemoteHostConfig = typeof RemoteHostConfig.Type;
export const RemoteHostInput = Schema.Struct({
  enabled: Schema.Boolean,
  name: Name,
  rotate: Schema.optional(Schema.Boolean),
});
export const RemoteHostStatus = Schema.Struct({
  ...RemoteHostConfig.fields,
  state: Schema.Literal("disabled", "connecting", "login", "ready", "error"),
  loginUrl: Schema.optional(TailscaleLoginUrl),
  nodeId: Schema.optional(RemoteId),
  message: Schema.optional(Schema.String),
});
export type RemoteHostStatus = typeof RemoteHostStatus.Type;
export const RemoteIdentity = Schema.Struct({ hostId: RemoteId, name: Name });
export const TransportConfig = Schema.Union(
  Schema.Struct({
    version: Schema.Literal(1),
    mode: Schema.Literal("host"),
    directory: Schema.String.pipe(Schema.minLength(1)),
    localPort: RemotePort,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    mode: Schema.Literal("client"),
    directory: Schema.String.pipe(Schema.minLength(1)),
    peerNodeId: RemoteId,
  }),
);
export type TransportConfig = typeof TransportConfig.Type;
export const TransportEvent = Schema.Union(
  Schema.Struct({ type: Schema.Literal("login"), url: TailscaleLoginUrl }),
  Schema.Struct({
    type: Schema.Literal("ready"),
    nodeId: RemoteId,
    port: RemotePort,
  }),
  Schema.Struct({ type: Schema.Literal("error"), message: Schema.String }),
);
export type TransportEvent = typeof TransportEvent.Type;
export const DesktopConnectionStatus = Schema.Struct({
  mode: Schema.Literal("local", "remote"),
  name: Name,
  phase: Schema.Literal("connecting", "login", "connected", "disconnected", "error"),
  canLogin: Schema.Boolean,
  message: Schema.optional(Schema.String),
});
export type DesktopConnectionStatus = typeof DesktopConnectionStatus.Type;
