import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const key = process.env.TYPESAFE_API_KEY;
if (!key) {
  console.error("TYPESAFE_API_KEY is required to record live fixtures.");
  process.exitCode = 1;
} else {
  const directory = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures");
  const model = "jev-1.14.0";
  const scenarios = {
    "batch-zh": {
      state: { message: "帮我调研一下竞品，下周给我一份简短报告，不着急。" },
      questions: {
        route: {
          type: "choice",
          instructions: "Which bot should handle this request?",
          criteria: {
            research: "Investigate competitors and summarize findings",
            coding: "Implement or debug software",
            general: "Other requests",
          },
        },
        urgent: { type: "noul", instructions: "Does the user require immediate action today?" },
        detail: {
          type: "score",
          instructions: "How much detail does the requested report require?",
          criteria: [
            "A short high-level summary",
            "A moderate explanation",
            "An exhaustive detailed analysis",
          ],
        },
      },
    },
    "single-option": {
      state: "Research competitors.",
      questions: {
        route: {
          type: "choice",
          instructions: "Select the available bot.",
          criteria: { research: "Research work" },
        },
      },
    },
  };
  await mkdir(directory, { recursive: true });
  for (const [scenario, input] of Object.entries(scenarios)) {
    const request = { model, ...input };
    const started = performance.now();
    try {
      const response = await fetch("https://api.typesafe.ai/v1/systemone", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(request),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        console.error(`${scenario}: HTTP ${response.status}; no response body recorded.`);
        process.exitCode = 1;
        continue;
      }
      const body = await response.json();
      const latencyMs = Math.round(performance.now() - started);
      await writeFile(
        resolve(directory, `${scenario}.json`),
        `${JSON.stringify(
          {
            source: "live-typesafe-api",
            recordedAt: new Date().toISOString(),
            endpoint: "https://api.typesafe.ai/v1/systemone",
            model,
            scenario,
            latencyMs,
            request,
            response: body,
          },
          null,
          2,
        )}\n`,
      );
      console.log(`${scenario}: recorded HTTP 200, model ${body.model}, ${latencyMs} ms.`);
    } catch {
      console.error(`${scenario}: request failed; credentials and response details omitted.`);
      process.exitCode = 1;
    }
  }
}
