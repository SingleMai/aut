// Endpoint validation adapted from OpenMausBot server/decider/jev.ts, commit 738ec88472a3b888ff7b7793755d89da613ed301.
// Copyright 2026 Milind Soni and OpenMausBot contributors. Apache-2.0. See NOTICE.
import { Schema } from "effect";
import { NonEmptyString } from "./common.js";

export const JEV_MODEL = "jev-1.14.0";
export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

export const JevServiceConfig = Schema.Struct({
  model: Schema.String.pipe(Schema.pattern(/^jev-\d+\.\d+\.\d+$/)),
  endpoint: NonEmptyString.pipe(
    Schema.filter((value) => {
      const url = Schema.decodeUnknownOption(Schema.URL)(value);
      return (
        url._tag === "Some" &&
        !url.value.username &&
        !url.value.password &&
        !url.value.search &&
        !url.value.hash &&
        (url.value.protocol === "https:" ||
          (url.value.protocol === "http:" &&
            ["localhost", "127.0.0.1", "[::1]"].includes(url.value.hostname)))
      );
    }),
  ),
});
