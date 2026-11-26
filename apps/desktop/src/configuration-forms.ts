import {
  BotConfig,
  type BotModelOption,
  ClassifierConfig,
  RoutingCandidateId,
  SecretReference,
} from "@aut/protocol";
import { Data, Effect, Either, ParseResult, Schema } from "effect";

import { t } from "./i18n.js";

export type ClassifierSlot = "primary" | "fallback";
export type FieldMessages = Readonly<Record<string, string>>;
export class FieldErrors extends Data.TaggedError("FieldErrors")<{
  readonly fields: FieldMessages;
}> {}

const messages = t.validation;
export const validKeyReference = Schema.is(SecretReference);

const formText = (data: FormData, name: string) => String(data.get(name) ?? "");

function decodeForm<A, I>(
  schema: Schema.Schema<A, I>,
  input: unknown,
  errors: Record<string, string>,
  locate: (path: readonly PropertyKey[]) => readonly [string, string] | undefined,
): Effect.Effect<A, FieldErrors> {
  const decoded = Schema.decodeUnknownEither(schema)(input, {
    errors: "all",
    onExcessProperty: "error",
  });
  if (Either.isLeft(decoded)) {
    for (const issue of ParseResult.ArrayFormatter.formatErrorSync(decoded.left)) {
      const field = locate(issue.path);
      if (field) errors[field[0]] ??= field[1];
    }
    return Effect.fail(new FieldErrors({ fields: errors }));
  }
  return Object.keys(errors).length
    ? Effect.fail(new FieldErrors({ fields: errors }))
    : Effect.succeed(decoded.right);
}

export function readBotForm(
  form: FormData,
  bot?: BotConfig,
  available?: { bots: readonly BotConfig[]; options: readonly BotModelOption[] },
) {
  const errors: Record<string, string> = {};
  const read = (name: string) => formText(form, name).trim();
  const id = bot?.id ?? read("id");
  if (id && !bot) {
    if (!Schema.is(RoutingCandidateId)(id)) errors.id = messages.reservedBotId;
    else if (available?.bots.some((existing) => existing.id === id))
      errors.id = messages.duplicateBotId;
  }
  const instance = read("instance");
  if (available && !available.options.some((option) => option.instance.id === instance))
    errors.instance = messages.instance;
  const effort = read("effort");
  const speed = read("speed");
  const characterId = form.has("characterId") ? formText(form, "characterId") : bot?.characterId;
  return decodeForm(
    BotConfig,
    {
      id,
      name: read("name"),
      ...(characterId ? { characterId } : {}),
      description: read("description"),
      soul: formText(form, "soul"),
      cwd: read("cwd"),
      modelSelection: {
        instanceId: instance,
        model: read("model"),
        ...(effort ? { effort } : {}),
        ...(speed ? { speed } : {}),
      },
      ...(bot?.system ? { system: bot.system } : {}),
    },
    errors,
    ([field, child]) => {
      if (field === "modelSelection")
        return [child === "instanceId" ? "instance" : String(child), messages.required];
      return [String(field), messages.required];
    },
  );
}

function readBackend(form: FormData, slot: ClassifierSlot, errors: Record<string, string>) {
  const read = (name: string) => formText(form, `${slot}.${name}`).trim();
  const backend = read("backend"),
    model = read("model"),
    endpoint = read("endpoint"),
    apiKeyRef = read("key");
  if (apiKeyRef && !validKeyReference(apiKeyRef)) errors[`${slot}.key`] = messages.keyReference;
  // Saving a credential independently fills its reference without enabling a backend.
  if (!backend && !model && !endpoint) return undefined;
  return { backend, model, endpoint, ...(apiKeyRef ? { apiKeyRef } : {}) };
}

const optionalClassifier = Schema.UndefinedOr(ClassifierConfig);

export function readClassifierForm(form: FormData) {
  const errors: Record<string, string> = {};
  const primary = readBackend(form, "primary", errors);
  const fallback = readBackend(form, "fallback", errors);
  if (fallback && !primary) errors["primary.backend"] = messages.missingPrimary;
  return decodeForm(
    optionalClassifier,
    primary || fallback ? { primary, ...(fallback && { fallback }) } : undefined,
    errors,
    ([slot, field]) => {
      if (!field) return undefined;
      const message =
        field === "endpoint"
          ? messages.endpoint
          : field === "model"
            ? messages.model
            : messages.required;
      return [`${String(slot)}.${field === "apiKeyRef" ? "key" : String(field)}`, message];
    },
  );
}
