import type { BotModelOption, BotModelsResponse, HarnessInstanceConfig } from "@aut/protocol";
import { Effect } from "effect";
import { useEffect, useState } from "react";
import { desktopApi } from "../api.js";
import { t } from "../i18n.js";

type ReadState = "loading" | "ready" | "failed";
type ProviderList = { options: readonly BotModelOption[]; status: ReadState };

/** Ignore any late result after React switches the provider, directory, or editor. */
function readWhileMounted<A, E>(
  read: Effect.Effect<A, E>,
  success: (value: A) => void,
  failure: () => void,
) {
  let active = true;
  const cancel = Effect.runCallback(
    Effect.match(read, {
      onSuccess: (value) => {
        if (active) success(value);
      },
      onFailure: () => {
        if (active) failure();
      },
    }),
  );
  return () => {
    active = false;
    cancel();
  };
}

export function useBotModelOptions(instances: readonly HarnessInstanceConfig[]) {
  const [list, setList] = useState<ProviderList>(() => ({
    status: "loading",
    options: instances.map((instance) => ({
      instance,
      configured: true,
      availability: "unknown",
      discovery: false,
      verification: "preview",
    })),
  }));
  const loading = list.status === "loading";
  useEffect(() => {
    if (!loading) return;
    return readWhileMounted(
      desktopApi.listBotModelOptions(),
      ({ options }) => setList({ options, status: "ready" }),
      () => setList((previous) => ({ ...previous, status: "failed" })),
    );
  }, [loading]);
  return {
    ...list,
    refresh: () => setList((previous) => ({ ...previous, status: "loading" })),
  };
}

function unavailable(source: BotModelOption | undefined, directory: string) {
  if (source?.availability === "missing") return t.botProgramMissing(source.instance.name);
  if (source?.availability === "unsupported") return t.botProgramUnsupported;
  if (!source?.discovery) return t.botModelsManual;
  if (!directory) return t.botModelDirectory;
  return "";
}

const catalogKey = (instanceId: string, directory: string) =>
  JSON.stringify([instanceId, directory]);

export function useModelCatalog(
  source: BotModelOption | undefined,
  cwd: string,
  open: boolean,
  listStatus: ReadState,
) {
  const [catalogs, setCatalogs] = useState<Record<string, BotModelsResponse>>({});
  const [request, setRequest] = useState<{ key: string; state: "loading" | "failed" }>();
  const directory = cwd.trim();
  const key = catalogKey(source?.instance.id ?? "", directory);
  const cached = catalogs[key];
  const blocked = unavailable(source, directory);
  useEffect(() => {
    if (!open || listStatus === "loading" || !source || blocked || cached) return;
    setRequest({ key, state: "loading" });
    return readWhileMounted(
      desktopApi.discoverBotModels({ instance: source.instance, cwd: directory }),
      (response) => setCatalogs((previous) => ({ ...previous, [key]: response })),
      () => setRequest({ key, state: "failed" }),
    );
  }, [open, listStatus, source, blocked, cached, directory, key]);

  const state = !cached && request?.key === key ? request.state : undefined;
  const error = listStatus === "failed" || state === "failed";
  const loading = listStatus === "loading" || state === "loading";
  function message() {
    if (listStatus === "loading") return t.botModelsReading;
    if (listStatus === "failed") return t.botModelOptionsFailed;
    if (blocked) return blocked;
    if (state === "failed") return t.botModelsFailed;
    if (state === "loading") return t.botModelsReading;
    return cached?.models.length === 0 ? t.botModelsEmpty : "";
  }
  return {
    models: cached?.models ?? [],
    modelsFor: (instanceId: string) => catalogs[catalogKey(instanceId, directory)]?.models,
    message: message(),
    error,
    loading,
    clear: () => {
      setCatalogs({});
      setRequest(undefined);
    },
  };
}
