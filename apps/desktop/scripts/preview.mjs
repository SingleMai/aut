import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Stream } from "effect";
import { DesktopConnection, DesktopConnectionLive } from "../dist/connection.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.AUT_PREVIEW_PORT ?? 5177);
const origin = `http://127.0.0.1:${port}`;
const bridge = `window.aut={request:async(input)=>{const response=await fetch('/api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});return response.json()},onNotice:(listener)=>{const stream=new EventSource('/events');stream.onmessage=event=>listener(JSON.parse(event.data));return()=>stream.close()}};`;
const clients = new Set();
const program = Effect.scoped(
  Effect.gen(function* () {
    const api = yield* DesktopConnection;
    const server = createServer(async (req, res) => {
      try {
        if (req.headers.origin && req.headers.origin !== origin) {
          res.writeHead(403);
          res.end();
          return;
        }
        if (req.url === "/events") {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
          res.write(": connected\n\n");
          clients.add(res);
          req.on("close", () => clients.delete(res));
          return;
        }
        if (
          req.url === "/api" &&
          req.method === "POST" &&
          req.headers["content-type"] === "application/json"
        ) {
          const chunks = [];
          let length = 0;
          for await (const chunk of req) {
            length += chunk.length;
            if (length > 1024 * 1024) {
              res.writeHead(413);
              res.end();
              return;
            }
            chunks.push(chunk);
          }
          const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          const result = await Effect.runPromise(
            api.request(value).pipe(
              Effect.catchAll((error) =>
                Effect.succeed({
                  ok: false,
                  error: { code: error.code, message: error.message },
                }),
              ),
            ),
          );
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify(result));
          return;
        }
        const path = req.url === "/" ? "index.html" : req.url?.slice(1);
        if (path === "preview-bridge.js") {
          res.writeHead(200, { "content-type": "text/javascript" });
          res.end(bridge);
          return;
        }
        if (
          !["index.html", "ui.js", "style.css"].includes(path) &&
          !/^fonts\/geist-[a-z0-9-]+\.woff2$/.test(path)
        ) {
          res.writeHead(404);
          res.end();
          return;
        }
        let body = await readFile(
          resolve(root, "dist", path),
          path.endsWith(".woff2") ? undefined : "utf8",
        );
        if (path === "index.html")
          body = body.replace(
            '<script type="module"',
            '<script src="preview-bridge.js"></script><script type="module"',
          );
        res.writeHead(200, {
          "content-type": path.endsWith(".woff2")
            ? "font/woff2"
            : path.endsWith(".css")
              ? "text/css"
              : path.endsWith(".js")
                ? "text/javascript"
                : "text/html",
          "cache-control": "no-store",
        });
        res.end(body);
      } catch {
        res.writeHead(500);
        res.end("Preview request failed");
      }
    });
    yield* Effect.acquireRelease(
      Effect.async((resume) => server.listen(port, "127.0.0.1", () => resume(Effect.void))),
      () =>
        Effect.sync(() => {
          for (const client of clients) client.end();
          server.close();
          server.closeAllConnections();
        }),
    );
    yield* api.notices.pipe(
      Stream.runForEach((notice) =>
        Effect.sync(() => {
          for (const client of clients) client.write(`data: ${JSON.stringify(notice)}\n\n`);
        }),
      ),
      Effect.forkScoped,
    );
    console.log(`Desktop preview: ${origin}`);
    yield* Effect.async((resume) => {
      process.once("SIGTERM", () => resume(Effect.void));
      process.once("SIGINT", () => resume(Effect.void));
    });
  }).pipe(
    Effect.provide(
      DesktopConnectionLive({
        daemonEntry: resolve(root, "../../packages/daemon/dist/main.js"),
        executable: process.execPath,
        ...(process.env.AUT_DATA_DIR ? { dataDirectory: process.env.AUT_DATA_DIR } : {}),
        port: Number(process.env.AUT_PORT ?? 4317),
      }),
    ),
  ),
);
await Effect.runPromise(program);
