import { spawn } from "node:child_process";
import readline from "node:readline";

const child = spawn("codex", ["app-server"], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
const lines = readline.createInterface({ input: child.stdout });
let nextId = 1;
const pending = new Map();
let stderr = "";

child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result);
});

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ method, id, params });
  });
}

const timeout = setTimeout(() => {
  child.kill();
  throw new Error(`app-server verification timed out\n${stderr}`);
}, 30_000);

try {
  const initialized = await request("initialize", {
    clientInfo: { name: "codex_board_verifier", title: "Codex Board verifier", version: "0.1.0" },
  });
  send({ method: "initialized", params: {} });

  let cursor = null;
  const threads = [];
  do {
    const page = await request("thread/list", {
      cursor,
      limit: 100,
      sortKey: "recency_at",
      sortDirection: "desc",
      sourceKinds: ["cli", "vscode", "appServer"],
      archived: false,
    });
    threads.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor);

  const named = threads.find((thread) => typeof thread.name === "string" && thread.name.length > 0);
  let renameVerified = false;
  if (named) {
    await request("thread/name/set", { threadId: named.id, name: named.name });
    renameVerified = true;
  }

  console.log(JSON.stringify({
    userAgent: initialized.userAgent ?? null,
    platformFamily: initialized.platformFamily ?? null,
    platformOs: initialized.platformOs ?? null,
    threadCount: threads.length,
    namedThreadCount: threads.filter((thread) => thread.name).length,
    renameVerified,
    firstThreadFields: threads[0] ? Object.keys(threads[0]).sort() : [],
  }, null, 2));
} finally {
  clearTimeout(timeout);
  child.stdin.end();
  child.kill();
}
