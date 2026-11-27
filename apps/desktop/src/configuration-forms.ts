import {
  BotConfig,
  type BotModelOption,
  type ClassifierBackendConfig,
  ClassifierConfig,
  JEV_ENDPOINT,
  JevServiceConfig,
  RoutingCandidateId,
  SecretReference,
} from "@aut/protocol";
import { Data, Effect, Either, ParseResult, Schema } from "effect";

import { t } from "./i18n.js";

export type ClassifierSlot = "primary" | "fallback";
export const validKeyReference = Schema.is(SecretReference);

export function classifierSource(value: ClassifierBackendConfig) {
  if (
    value.backend !== "jev" ||
    !Schema.is(JevServiceConfig)(value) ||
    (value.apiKeyRef && !validKeyReference(value.apiKeyRef))
  )
    return "existing";
  return value.endpoint === JEV_ENDPOINT ? "official" : "custom";
}

export function classifierLabel(value?: ClassifierBackendConfig) {
  if (!value) return t.fastBrainUnconfigured;
  const source = classifierSource(value);
  return source === "existing"
    ? t.fastBrainLegacy(value.backend, value.model)
    : t.fastBrainSources[source];
}

export type FieldMessages = Readonly<Record<string, string>>;
export class FieldErrors extends Data.TaggedError("FieldErrors")<{
  readonly fields: FieldMessages;
}> {}

const messages = t.validation;

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
  const source = formText(form, `${slot}.source`);
  if (source !== "official" && source !== "custom" && source !== "existing") {
    if (slot === "primary" || source) errors[`${slot}.source`] = messages.fastBrainSource;
    return undefined;
  }
  const read = (name: string) => {
    const value = formText(form, `${slot}.${name}`);
    return source === "existing" ? value : value.trim();
  };
  if (form.has(`${slot}.pendingCredential`))
    errors[`${slot}.credential`] = messages.unsavedCredential;
  const jev = source === "official" || source === "custom";
  const backend = jev ? "jev" : read("backend");
  const model = read("model");
  const endpoint = source === "official" ? JEV_ENDPOINT : read("endpoint");
  const apiKeyRef = read("key");
  if (jev) {
    if (!Schema.is(JevServiceConfig.fields.model)(model))
      errors[`${slot}.model`] = messages.jevModel;
    if (!Schema.is(JevServiceConfig.fields.endpoint)(endpoint))
      errors[`${slot}.endpoint`] = messages.jevEndpoint;
  }
  if (source !== "existing" && apiKeyRef && !validKeyReference(apiKeyRef))
    errors[`${slot}.key`] = messages.keyReference;
  return { backend, model, endpoint, ...(apiKeyRef ? { apiKeyRef } : {}) };
}

export function readClassifierForm(form: FormData) {
  const errors: Record<string, string> = {};
  const primary = readBackend(form, "primary", errors);
  const fallback = readBackend(form, "fallback", errors);
  return decodeForm(
    ClassifierConfig,
    { primary, ...(fallback && { fallback }) },
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
