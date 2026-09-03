#!/usr/bin/env node
// `npm run web` — serves the Keel console on localhost with no build step and no
// dependencies. It exists because the console imports `worker/pricer.js` and
// `worker/spreadPolicy.js` directly rather than reimplementing them: the prices
// on screen come from the same two modules the back-test scores and the Solidity
// library mirrors, so the demo cannot drift from the contract.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, normalize, join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const PORT = Number(process.env.PORT ?? 5173);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  let path = url.pathname === "/" ? "/web/index.html" : url.pathname;
  // Only ever serve out of the repo, and only the directories the console needs.
  // `contracts/out` is here because the Deploy step sends real creation bytecode
  // from the browser, and that bytecode lives in the Foundry build artifact.
  const resolved = normalize(join(ROOT, path));
  if (!resolved.startsWith(ROOT) || !/^(web|worker|deployments|contracts\/out)\//.test(resolved.slice(ROOT.length))) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const body = await readFile(resolved);
    res.writeHead(200, { "content-type": TYPES[extname(resolved)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

// Walk up from the preferred port rather than dying on EADDRINUSE. A console left
// running in another terminal is the normal case during a demo, not an error worth
// a stack trace.
function listen(port, attemptsLeft = 10) {
  server.once("error", (err) => {
    if (err.code !== "EADDRINUSE" || attemptsLeft === 0) throw err;
    console.log(`port ${port} is busy, trying ${port + 1}…`);
    listen(port + 1, attemptsLeft - 1);
  });
  server.listen(port, () => {
    console.log(`Keel console  ->  http://localhost:${port}`);
  });
}

listen(PORT);
