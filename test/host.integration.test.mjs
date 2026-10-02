/**
 * Host integration tests for dsh-launch-buttons.
 *
 * No real DSH is needed: a fake context provides `effect`, `get` and a
 * `webServer.register` that records the route, and the route is then served by
 * a plain http server so the tests can drive the JSON API with fetch.
 *
 * Run (from the plugin directory):
 *   node --test test/host.integration.test.mjs
 *
 * Nothing here starts a real program: every launch case is a refusal path.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * One sequential scenario over a throwaway DSH_HOME: the tests deliberately
 * share the store (each step builds on the previous one), so run the whole
 * file, not a single test.
 * No test starts a real process - every launch case is a refusal path.
 */

/** The OS temp directory is not always writable inside the sandbox. */
function makeSandboxHome() {
  const candidates = [
    process.env.DSH_LAUNCH_BUTTONS_TEST_HOME,
    join(here, ".tmp-home"),
  ].filter((value) => typeof value === "string" && value !== "");
  for (const candidate of candidates) {
    try {
      rmSync(candidate, { recursive: true, force: true });
      mkdirSync(candidate, { recursive: true });
      return candidate;
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error("could not create a sandbox DSH_HOME for the tests");
}

const SANDBOX_HOME = makeSandboxHome();
process.env.DSH_HOME = SANDBOX_HOME;

const TOOL_DIR = join(SANDBOX_HOME, "tool");
mkdirSync(TOOL_DIR, { recursive: true });
const TOOL_EXE = join(TOOL_DIR, "tool.exe");
writeFileSync(TOOL_EXE, "not a real executable", "utf8");

const WORKSPACE = join(SANDBOX_HOME, "workspace");
mkdirSync(WORKSPACE, { recursive: true });
// A launchable file plus one that the extension filter must drop: `browse`
// only offers what the plugin is willing to launch.
writeFileSync(join(WORKSPACE, "tool.exe"), "not a real executable", "utf8");
writeFileSync(join(WORKSPACE, "notes.txt"), "ignored", "utf8");

const plugin = await import("../lib/index.js");
const ROUTE = "/dsh-launch-buttons";

const registered = [];
const workspaces = [{ path: WORKSPACE, title: "sandbox", sessionIds: ["s1", "s2"] }];
const ctx = {
  effect(callback) {
    return callback();
  },
  get(name) {
    if (name === "workspaceRegistry") return { list: () => workspaces };
    return undefined;
  },
  webServer: {
    register(route) {
      registered.push(route);
      return () => {};
    },
    registerUpgrade() {
      return () => {};
    },
  },
};

test("apply() registers the launch route", () => {
  plugin.apply(ctx);
  assert.equal(plugin.name, "dsh-launch-buttons");
  assert.deepEqual(plugin.inject, ["webServer"]);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].path, ROUTE);
  assert.equal(registered[0].kind, "prefix");
});

const server = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  const match = registered.find((route) => path === route.path || path.startsWith(`${route.path}/`));
  if (match === undefined) {
    res.writeHead(404);
    res.end("no route");
    return;
  }
  match.handler(req, res);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => {
  server.close();
  rmSync(SANDBOX_HOME, { recursive: true, force: true });
});

function readStoreFile() {
  return JSON.parse(readFileSync(join(SANDBOX_HOME, "launch-buttons", "store.json"), "utf8"));
}

async function call(action, options = {}) {
  const url = new URL(`${base}${ROUTE}/${action}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers: options.body === undefined ? undefined : { "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

test("health reports the multi-item strategy", async () => {
  const { status, json } = await call("health");
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.strategy, "multi-item");
  assert.equal(json.builtinId, "workspace");
  assert.equal(json.storePath, join(SANDBOX_HOME, "launch-buttons", "store.json"));
});

test("a fresh conversation launches its workspace directory", async () => {
  const { status, json } = await call("state", { query: { sessionId: "s1" } });
  assert.equal(status, 200);
  assert.equal(json.defaultId, "workspace");
  assert.equal(json.defaultItem.path, WORKSPACE);
  assert.deepEqual(json.items.map((item) => item.id), ["workspace"]);
  assert.equal(json.items[0].scope, "builtin");
  assert.equal(json.items[0].editable, false);
  assert.equal(json.workspace.path, WORKSPACE);
});

test("a conversation without a workspace has nothing to launch", async () => {
  const { json } = await call("state", { query: { sessionId: "unknown" } });
  assert.equal(json.defaultId, null);
  assert.deepEqual(json.items, []);
  assert.equal(json.workspace, null);
});

test("adding an item makes it the first row and keeps the workspace as default", async () => {
  const added = await call("item/add", { method: "POST", body: { sessionId: "s1", scope: "session", label: "工具", path: TOOL_EXE } });
  assert.equal(added.status, 200);
  assert.equal(added.json.ok, true);
  assert.equal(added.json.added.path, TOOL_EXE);
  assert.deepEqual(added.json.items.map((item) => item.scope), ["session", "builtin"]);
  assert.equal(added.json.items[0].label, "工具");
  assert.equal(added.json.items[0].exists, true);
  assert.equal(added.json.items[0].kind, "executable");
  assert.equal(added.json.defaultId, "workspace");
  assert.equal(added.json.sessionItemCount, 1);
});

test("items are persisted on disk", async () => {
  const { json } = await call("state", { query: { sessionId: "s1" } });
  const id = json.items[0].id;
  const store = readStoreFile();
  assert.equal(store.version, 2);
  assert.deepEqual(store.sessions.s1.items.map((item) => item.id), [id]);
});

test("the default can be pinned to an item, then back to the workspace", async () => {
  const before = await call("state", { query: { sessionId: "s1" } });
  const id = before.json.items[0].id;
  const pinned = await call("item/default", { method: "POST", body: { sessionId: "s1", id, scope: "session" } });
  assert.equal(pinned.status, 200);
  assert.equal(pinned.json.defaultId, id);
  assert.equal(pinned.json.defaultItem.label, "工具");
  const back = await call("item/default", { method: "POST", body: { sessionId: "s1", id: "workspace", scope: "session" } });
  assert.equal(back.json.defaultId, "workspace");
});

test("an item can be renamed and re-pointed", async () => {
  const before = await call("state", { query: { sessionId: "s1" } });
  const id = before.json.items[0].id;
  const updated = await call("item/update", {
    method: "POST",
    body: { sessionId: "s1", scope: "session", id, label: "工具 2", path: TOOL_DIR },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.items[0].label, "工具 2");
  assert.equal(updated.json.items[0].path, TOOL_DIR);
  assert.equal(updated.json.items[0].kind, "directory");
});

test("mutations reject bad input", async () => {
  const relative = await call("item/add", { method: "POST", body: { sessionId: "s1", scope: "session", path: "tool.exe" } });
  assert.equal(relative.status, 400);
  assert.match(relative.json.error, /绝对路径/);
  const missing = await call("item/add", { method: "POST", body: { sessionId: "s1", scope: "session", path: join(SANDBOX_HOME, "ghost.exe") } });
  assert.equal(missing.status, 400);
  assert.match(missing.json.error, /不存在/);
  const noSession = await call("item/add", { method: "POST", body: { scope: "session", path: TOOL_EXE } });
  assert.equal(noSession.status, 400);
  const unknown = await call("item/update", { method: "POST", body: { sessionId: "s1", scope: "session", id: "ghost", label: "x" } });
  assert.equal(unknown.status, 400);
  assert.match(unknown.json.error, /找不到/);
});

test("workspace-scoped items are shared by every conversation of that workspace", async () => {
  const added = await call("item/add", { method: "POST", body: { sessionId: "s1", scope: "workspace", label: "共享", path: TOOL_DIR } });
  assert.equal(added.status, 200);
  assert.equal(added.json.workspaceItemCount, 1);
  const other = await call("state", { query: { sessionId: "s2" } });
  assert.equal(other.json.sessionItemCount, 0);
  assert.deepEqual(other.json.items.map((item) => item.scope), ["workspace", "builtin"]);
  assert.equal(other.json.items[0].label, "共享");
});

test("launch refuses a target that no longer exists, without starting anything", async () => {
  const { status, json } = await call("launch", {
    method: "POST",
    body: { sessionId: "s1", path: join(SANDBOX_HOME, "vanished.exe") },
  });
  assert.equal(status, 400);
  assert.equal(json.ok, false);
  assert.match(json.error, /不存在/);
  const unknown = await call("launch", { method: "POST", body: { sessionId: "s1", itemId: "ghost" } });
  assert.equal(unknown.status, 400);
  assert.match(unknown.json.error, /找不到启动项/);
});

test("browse lists launchable entries and explains refusals", async () => {
  const root = await call("browse", { query: { sessionId: "s1" } });
  assert.equal(root.status, 200);
  assert.equal(root.json.path, null);
  assert.ok(root.json.roots.some((entry) => entry.path === WORKSPACE));
  const listing = await call("browse", { query: { sessionId: "s1", path: WORKSPACE } });
  assert.equal(listing.status, 200);
  assert.equal(listing.json.path, WORKSPACE);
  assert.equal(listing.json.parent, SANDBOX_HOME);
  // `tool.exe` was written into WORKSPACE when the fixture was created: the file
  // branch must survive the launchable-extension filter.
  assert.deepEqual(listing.json.entries.map((entry) => entry.name), ["tool.exe"]);
  assert.equal(listing.json.entries[0].kind, "shell");
  const relative = await call("browse", { query: { sessionId: "s1", path: "relative" } });
  assert.equal(relative.status, 400);
  const missing = await call("browse", { query: { sessionId: "s1", path: join(SANDBOX_HOME, "ghost") } });
  assert.equal(missing.status, 400);
});

test("removing and clearing keep the two scopes apart", async () => {
  const before = await call("state", { query: { sessionId: "s1" } });
  const sessionItem = before.json.items.find((item) => item.scope === "session");
  const removed = await call("item/remove", { method: "POST", body: { sessionId: "s1", scope: "session", id: sessionItem.id } });
  assert.equal(removed.status, 200);
  assert.equal(removed.json.sessionItemCount, 0);
  assert.equal(removed.json.workspaceItemCount, 1);
  const cleared = await call("clear", { method: "POST", body: { sessionId: "s1", scope: "all" } });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json.sessionItemCount, 0);
  assert.equal(cleared.json.workspaceItemCount, 0);
  const other = await call("state", { query: { sessionId: "s2" } });
  assert.equal(other.json.workspaceItemCount, 0);
});

test("routing refuses unknown actions and wrong methods", async () => {
  const missing = await call("nope");
  assert.equal(missing.status, 404);
  const wrongMethod = await call("state", { method: "PUT", body: {} });
  assert.equal(wrongMethod.status, 405);
  // Both directions must be 405, not 404: the action exists, the verb is wrong.
  const postOnGet = await call("state", { method: "POST", body: { sessionId: "s1" } });
  assert.equal(postOnGet.status, 405);
  const getOnPost = await call("launch", { query: { sessionId: "s1" } });
  assert.equal(getOnPost.status, 405);
  const postOnHealth = await call("health", { method: "POST", body: {} });
  assert.equal(postOnHealth.status, 405);
  const outside = await call("item/add", { method: "POST", body: { path: TOOL_EXE } });
  assert.equal(outside.status, 400);
});

test("a bare GET answers health and an oversized body is refused", async () => {
  const bare = await call("");
  assert.equal(bare.status, 200);
  assert.equal(bare.json.plugin, "dsh-launch-buttons");
  assert.equal(bare.json.strategy, "multi-item");

  const huge = await call("clear", {
    method: "POST",
    body: { sessionId: "s1", scope: "session", pad: "x".repeat(9000) },
  });
  assert.equal(huge.status, 413);
  assert.equal(huge.json.ok, false);
  assert.match(huge.json.error, /过大/);
});

test("the single binding of the original plugin is imported once", async () => {
  rmSync(join(SANDBOX_HOME, "launch-buttons"), { recursive: true, force: true });
  mkdirSync(join(SANDBOX_HOME, "launch-button"), { recursive: true });
  writeFileSync(
    join(SANDBOX_HOME, "launch-button", "bindings.json"),
    JSON.stringify({ version: 1, sessions: { s1: { path: TOOL_EXE, label: "旧绑定", at: null } }, workspaces: {}, recent: [] }),
    "utf8",
  );
  const state = await call("state", { query: { sessionId: "s1" } });
  assert.equal(state.json.sessionItemCount, 1);
  assert.equal(state.json.items[0].label, "旧绑定");
  assert.equal(state.json.defaultId, state.json.items[0].id);
  assert.equal(state.json.defaultItem.path, TOOL_EXE);
  const store = readStoreFile();
  assert.equal(store.version, 2);
  assert.equal(store.sessions.s1.defaultId, store.sessions.s1.items[0].id);
});
