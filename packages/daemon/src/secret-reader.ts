import { JEV_DEFAULT_KEY_REF } from "@aut/protocol";
import { Context, Effect, Layer, Redacted } from "effect";
import { DaemonError } from "./errors.js";
import { SecretStore } from "./secret-store.js";

export class SecretReader extends Context.Tag("aut/SecretReader")<
  SecretReader,
  {
    readonly resolve: (reference?: string) => Effect.Effect<Redacted.Redacted<string>, DaemonError>;
  }
>() {}

/** Existing environment credentials remain available without changing shell or provider files. */
export const EnvironmentSecretReaderLive = Layer.succeed(SecretReader, {
  resolve: (reference = JEV_DEFAULT_KEY_REF) =>
    Effect.suspend(() => {
      const name = reference.startsWith("env:") ? reference.slice(4) : reference;
      if (!/^[A-Z_][A-Z0-9_]*$/.test(name))
        return Effect.fail(
          new DaemonError({
            code: "Unavailable",
            message: "The credential reference cannot be resolved",
          }),
        );
      const value = process.env[name];
      return value?.trim()
        ? Effect.succeed(Redacted.make(value))
        : Effect.fail(
            new DaemonError({
              code: "Unavailable",
              message: "The classifier credential is not configured",
            }),
          );
    }),
});

/** Explicit local references use the isolated file store; environment references retain their meaning. */
export const SecretReaderLive = Layer.effect(
  SecretReader,
  Effect.gen(function* () {
    const store = yield* SecretStore;
    const environment = yield* SecretReader.pipe(Effect.provide(EnvironmentSecretReaderLive));
    return {
      resolve: (reference?: string) =>
        reference?.startsWith("secret:")
          ? store.resolve(reference)
          : environment.resolve(reference),
    };
  }),
);
