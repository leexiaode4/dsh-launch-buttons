/**
 * dsh-launch-buttons - host half.
 *
 * Serves the tiny loopback JSON API the composer button talks to, and does the
 * one thing a client cannot: start a detached process / open a directory with
 * its registered application. It is the multi-item copy of
 * `dsh-launch-button`: the store is `$DSH_HOME/launch-buttons/store.json` and
 * every scope holds a list of items plus a default.
 *
 * On first read, when no store of its own exists yet, the single binding the
 * original plugin wrote to `$DSH_HOME/launch-button/bindings.json` is imported
 * (and left in place) so the new button behaves exactly like the old one until
 * you configure something.
 *
 * The process launch deliberately avoids `windowsHide` / `detached`. On this
 * machine `windowsHide: true` becomes CREATE_NO_WINDOW, and the child then dies
 * in the loader with 0xC0000142 (`STATUS_DLL_INIT_FAILED`) even though spawn
 * reports success; `detached: true` (DETACHED_PROCESS) fails the same way.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve as resolvePath } from "node:path";

import {
  BUILTIN_ID,
  MAX_ITEMS_PER_BUCKET,
  SCOPE,
  TARGET_KIND,
  bucketOf,
  buildLaunchPlan,
  classifyTarget,
  clearScope,
  emptyStore,
  extensionOf,
  findItem,
  isAbsolutePath,
  isLoopbackAddress,
  listItems,
  makeItemId,
  normalizeStore,
  withDefaultId,
  withItem,
  withItemPatch,
  withoutItem,
  workspaceKey,
} from "./core.js";

export const name = "dsh-launch-buttons";
export const inject = ["webServer"];

const ROUTE = "/dsh-launch-buttons";
const MAX_BODY_BYTES = 8192;

const LAUNCHABLE_EXT = new Set([
  ".exe",
  ".com",
  ".bat",
  ".cmd",
  ".lnk",
  ".url",
  ".msi",
  ".ps1",
  ".vbs",
  ".appref-ms",
  ".jar",
]);

const MAX_BROWSE_ENTRIES = 500;

/* ────────────────────────────── store ────────────────────────────── */

function HOME() {
  return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

function STORE_DIR() {
  return join(HOME(), "launch-buttons");
}

function STORE_FILE() {
  return join(STORE_DIR(), "store.json");
}

/** Where the original single-binding plugin kept its state. */
function LEGACY_STORE_FILE() {
  return join(HOME(), "launch-button", "bindings.json");
}

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function readStore() {
  const own = readJsonFile(STORE_FILE());
  if (own !== undefined) return normalizeStore(own);
  const legacy = readJsonFile(LEGACY_STORE_FILE());
  if (legacy === undefined) return emptyStore();
  const migrated = normalizeStore(legacy);
  try {
    writeStore(migrated);
  } catch {
    /* the in-memory import still works for this run */
  }
  return migrated;
}

function writeStore(store) {
  const file = STORE_FILE();
  try {
    mkdirSync(STORE_DIR(), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
    renameSync(tmp, file);
  } catch {
    try {
      writeFileSync(file, JSON.stringify(store), "utf8");
    } catch {
      /* nothing else we can do; the next read falls back to defaults */
    }
  }
}

/* ────────────────────────────── targets ────────────────────────────── */

function statOf(path) {
  try {
    const stats = statSync(path);
    return { exists: true, isDirectory: stats.isDirectory(), isFile: stats.isFile() };
  } catch {
    return { exists: false, isDirectory: false, isFile: false };
  }
}

function describeItem(item, defaultId) {
  const stats = statOf(item.path);
  const kind = classifyTarget(item.path, stats);
  const fallback = basename(item.path);
  return {
    id: item.id,
    label: item.label ?? (fallback === "" ? item.path : fallback),
    path: item.path,
    at: item.at ?? null,
    scope: item.scope,
    kind,
    exists: kind !== TARGET_KIND.MISSING,
    isDefault: item.id === defaultId,
    editable: item.scope !== SCOPE.BUILTIN,
  };
}

/** The workspace (cwd) a session belongs to. */
function resolveWorkspace(ctx, sessionId) {
  if (typeof sessionId !== "string" || sessionId === "") return null;
  const registry = ctx.get?.("workspaceRegistry");
  if (registry === null || registry === undefined || typeof registry.list !== "function") return null;
  let workspaces;
  try {
    workspaces = registry.list();
  } catch {
    return null;
  }
  if (!Array.isArray(workspaces)) return null;
  for (const workspace of workspaces) {
    const ids = Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : [];
    if (ids.includes(sessionId)) {
      return { path: workspace.path ?? null, title: workspace.title ?? null };
    }
  }
  return null;
}

function workspaceOf(ctx, sessionId) {
  const workspace = resolveWorkspace(ctx, sessionId);
  const path = workspace?.path;
  if (typeof path === "string" && path !== "") {
    return { path, title: workspace.title ?? null };
  }
  return null;
}

/** Resolve the bucket a mutation targets, or explain why there is none. */
function scopeTarget(ctx, scope, sessionId) {
  const id = typeof sessionId === "string" ? sessionId.trim() : "";
  if (scope === SCOPE.WORKSPACE) {
    const workspace = workspaceOf(ctx, id);
    if (workspace === null) return { error: "这个对话没有关联的工作区目录，无法绑定到工作区" };
    return { key: workspaceKey(workspace.path), scope: SCOPE.WORKSPACE };
  }
  if (id === "") return { error: "缺少会话标识，无法绑定到这个对话" };
  return { key: id, scope: SCOPE.SESSION };
}

function readItemInput(body) {
  const raw = typeof body?.path === "string" ? body.path.trim() : "";
  if (raw === "") return { error: "请填写要启动的程序或目录路径" };
  if (!isAbsolutePath(raw)) return { error: "请填写绝对路径（例如 D:\\Games\\game.exe 或 C:\\Projects）" };
  const stats = statOf(raw);
  if (stats.exists !== true) return { error: `路径不存在：${raw}` };
  const label = typeof body?.label === "string" && body.label.trim() !== "" ? body.label.trim() : null;
  return { path: raw, label };
}

/* ────────────────────────────── state ────────────────────────────── */

function buildState(ctx, sessionId) {
  const workspace = workspaceOf(ctx, sessionId);
  const workspacePath = workspace?.path ?? null;
  const sessionKey = typeof sessionId === "string" ? sessionId.trim() : "";
  const store = readStore();
  const { items, defaultId } = listItems(store, sessionKey, workspacePath);
  const described = items.map((item) => describeItem(item, defaultId));
  const wsKey = workspaceKey(workspacePath);
  return {
    ok: true,
    route: ROUTE,
    sessionId: sessionKey === "" ? null : sessionKey,
    workspace,
    items: described,
    defaultId,
    defaultItem: described.find((item) => item.id === defaultId) ?? null,
    sessionItemCount: sessionKey === "" ? 0 : bucketOf(store, SCOPE.SESSION, sessionKey).items.length,
    workspaceItemCount: wsKey === null ? 0 : bucketOf(store, SCOPE.WORKSPACE, wsKey).items.length,
    maxItems: MAX_ITEMS_PER_BUCKET,
    storePath: STORE_FILE(),
  };
}

/* ────────────────────────────── actions ────────────────────────────── */

async function readState(ctx, body) {
  return buildState(ctx, body?.sessionId);
}

async function browseDirectory(ctx, body) {
  const raw = typeof body?.path === "string" ? body.path.trim() : "";
  const workspace = workspaceOf(ctx, body?.sessionId);
  const home = homedir();
  const roots = [];
  const pushRoot = (label, path) => {
    if (typeof path !== "string" || path === "") return;
    const stats = statOf(path);
    if (stats.exists !== true || stats.isDirectory !== true) return;
    if (roots.some((root) => workspaceKey(root.path) === workspaceKey(path))) return;
    roots.push({ label, path });
  };
  pushRoot("工作区", workspace?.path);
  pushRoot("主目录", home);
  pushRoot("桌面", join(home, "Desktop"));
  pushRoot("开始菜单", join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs"));
  pushRoot("全部用户", join(process.env.ProgramData ?? "C:\\ProgramData", "Microsoft", "Windows", "Start Menu", "Programs"));

  if (raw === "") {
    return { ok: true, route: ROUTE, path: null, parent: null, entries: [], roots, sessionId: body?.sessionId ?? null };
  }
  if (!isAbsolutePath(raw)) return { ok: false, error: "请填写绝对路径" };
  const stats = statOf(raw);
  if (stats.exists !== true) return { ok: false, error: `目录不存在：${raw}` };
  if (stats.isDirectory !== true) return { ok: false, error: `不是目录：${raw}` };
  const directory = resolvePath(raw);

  let dirents = [];
  try {
    dirents = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    return { ok: false, error: `无法读取目录：${directory}（${error?.code ?? error?.message ?? "unknown"}）` };
  }

  const entries = [];
  for (const dirent of dirents) {
    if (entries.length >= MAX_BROWSE_ENTRIES) break;
    const full = join(directory, dirent.name);
    if (dirent.isDirectory()) {
      entries.push({ name: dirent.name, path: full, kind: TARGET_KIND.DIRECTORY });
      continue;
    }
    if (!dirent.isFile() && !dirent.isSymbolicLink()) continue;
    if (!LAUNCHABLE_EXT.has(extensionOf(dirent.name))) continue;
    entries.push({ name: dirent.name, path: full, kind: TARGET_KIND.SHELL });
  }
  entries.sort((left, right) => {
    const leftDir = left.kind === TARGET_KIND.DIRECTORY ? 0 : 1;
    const rightDir = right.kind === TARGET_KIND.DIRECTORY ? 0 : 1;
    if (leftDir !== rightDir) return leftDir - rightDir;
    return left.name.localeCompare(right.name, "zh-Hans-CN");
  });

  const parent = resolvePath(directory, "..");
  return {
    ok: true,
    route: ROUTE,
    path: directory,
    parent: parent === directory ? null : parent,
    entries,
    roots,
    sessionId: body?.sessionId ?? null,
  };
}

async function launchTarget(ctx, body) {
  const sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
  const workspace = workspaceOf(ctx, sessionId);
  const workspacePath = workspace?.path ?? null;
  const store = readStore();

  let item = null;
  if (typeof body?.itemId === "string" && body.itemId !== "") {
    item = findItem(store, sessionId, workspacePath, body.itemId);
    if (item === null) return { ok: false, error: `找不到启动项：${body.itemId}` };
  } else if (typeof body?.path === "string" && body.path.trim() !== "") {
    item = { id: null, label: null, path: body.path.trim(), scope: null };
  } else {
    item = resolveDefaultItemSafe(store, sessionId, workspacePath);
    if (item === null) {
      return { ok: false, error: "这个对话没有工作区目录，也没有配置任何启动项" };
    }
  }

  const stats = statOf(item.path);
  const kind = classifyTarget(item.path, stats);
  if (kind === TARGET_KIND.MISSING) {
    const label = item.label ?? item.path;
    return { ok: false, error: `目标不存在：${label}（${item.path}）`, path: item.path, kind, itemId: item.id };
  }

  let plan;
  try {
    plan = buildLaunchPlan(item.path, kind);
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error), path: item.path, kind, itemId: item.id };
  }

  const outcome = await spawnIndependent(plan);
  if (outcome.ok !== true) {
    return { ok: false, error: outcome.error, path: item.path, kind, mode: plan.mode, itemId: item.id };
  }
  return {
    ok: true,
    path: item.path,
    kind,
    mode: plan.mode,
    label: item.label ?? (basename(item.path) === "" ? item.path : basename(item.path)),
    itemId: item.id,
    pid: outcome.pid,
  };
}

function resolveDefaultItemSafe(store, sessionId, workspacePath) {
  const { items, defaultId } = listItems(store, sessionId, workspacePath);
  if (defaultId === null) return items[0] ?? null;
  return items.find((item) => item.id === defaultId) ?? items[0] ?? null;
}

async function addItem(ctx, body) {
  const scope = body?.scope === SCOPE.WORKSPACE ? SCOPE.WORKSPACE : SCOPE.SESSION;
  const target = scopeTarget(ctx, scope, body?.sessionId);
  if (target.error) return { ok: false, error: target.error };
  const input = readItemInput(body);
  if (input.error) return { ok: false, error: input.error };
  const store = readStore();
  const id = makeItemId(Date.now(), Math.random);
  const item = { id, label: input.label, path: input.path, at: new Date().toISOString() };
  const next = withItem(store, target.scope, target.key, item);
  if (next === null) {
    return { ok: false, error: `一个范围内最多 ${MAX_ITEMS_PER_BUCKET} 个启动项，请先删掉几个` };
  }
  writeStore(next);
  return { ...buildState(ctx, body?.sessionId), added: { id, scope: target.scope, label: input.label, path: input.path } };
}

async function updateItem(ctx, body) {
  const scope = body?.scope === SCOPE.WORKSPACE ? SCOPE.WORKSPACE : SCOPE.SESSION;
  const target = scopeTarget(ctx, scope, body?.sessionId);
  if (target.error) return { ok: false, error: target.error };
  const id = typeof body?.id === "string" ? body.id : "";
  if (id === "") return { ok: false, error: "缺少启动项 id" };
  const patch = {};
  if (typeof body?.label === "string") patch.label = body.label;
  if (typeof body?.path === "string" && body.path.trim() !== "") {
    const raw = body.path.trim();
    if (!isAbsolutePath(raw)) return { ok: false, error: "请填写绝对路径" };
    if (statOf(raw).exists !== true) return { ok: false, error: `路径不存在：${raw}` };
    patch.path = raw;
  }
  const next = withItemPatch(readStore(), target.scope, target.key, id, patch);
  if (next === null) return { ok: false, error: `找不到启动项：${id}` };
  writeStore(next);
  return { ...buildState(ctx, body?.sessionId), updated: { id, scope: target.scope } };
}

async function removeItem(ctx, body) {
  const scope = body?.scope === SCOPE.WORKSPACE ? SCOPE.WORKSPACE : SCOPE.SESSION;
  const target = scopeTarget(ctx, scope, body?.sessionId);
  if (target.error) return { ok: false, error: target.error };
  const id = typeof body?.id === "string" ? body.id : "";
  const next = withoutItem(readStore(), target.scope, target.key, id);
  if (next === null) return { ok: false, error: `找不到启动项：${id}` };
  writeStore(next);
  return { ...buildState(ctx, body?.sessionId), removed: id };
}

async function setDefaultItem(ctx, body) {
  const id = typeof body?.id === "string" ? body.id : "";
  if (id === "") return { ok: false, error: "缺少启动项 id" };
  const sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
  const workspace = workspaceOf(ctx, sessionId);
  const store = readStore();
  const item = findItem(store, sessionId, workspace?.path ?? null, id);
  if (item === null) return { ok: false, error: `找不到启动项：${id}` };

  // Keep the pin where the item lives, so "default" survives a conversation
  // switch for workspace-bound items and stays local for session ones.
  const preferWorkspace = item.scope === SCOPE.WORKSPACE || (body?.scope === SCOPE.WORKSPACE && workspace !== null);
  const target = preferWorkspace && workspace !== null
    ? { key: workspaceKey(workspace.path), scope: SCOPE.WORKSPACE }
    : scopeTarget(ctx, SCOPE.SESSION, sessionId);
  if (target.error) return { ok: false, error: target.error };

  const next = withDefaultId(store, target.scope, target.key, id);
  if (next === null) return { ok: false, error: `找不到启动项：${id}` };
  writeStore(next);
  // The pin lives where the item lives; a session default can still shadow a
  // workspace one, so report the state as it will actually resolve.
  return buildState(ctx, sessionId);
}

async function clearItems(ctx, body) {
  const wanted = body?.scope;
  const scope = wanted === SCOPE.WORKSPACE || wanted === "all" ? wanted : SCOPE.SESSION;
  const sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
  const workspace = workspaceOf(ctx, sessionId);
  const next = clearScope(readStore(), sessionId, workspace?.path ?? null, scope);
  writeStore(next);
  return { ...buildState(ctx, sessionId), cleared: scope };
}

/* ────────────────────────────── process ────────────────────────────── */

function spawnIndependent(plan) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child;
    try {
      child = spawn(plan.command, plan.args, { stdio: "ignore" });
    } catch (error) {
      finish({ ok: false, error: error?.message ?? String(error) });
      return;
    }
    child.once("error", (error) => finish({ ok: false, error: error?.message ?? String(error) }));
    child.once("spawn", () => {
      try {
        child.unref();
      } catch {
        /* not fatal */
      }
      finish({ ok: true, pid: child.pid ?? null });
    });
  });
}

/* ────────────────────────────── http ────────────────────────────── */

const GET_ACTIONS = { state: readState, browse: browseDirectory };
const POST_ACTIONS = {
  launch: launchTarget,
  "item/add": addItem,
  "item/update": updateItem,
  "item/remove": removeItem,
  "item/default": setDefaultItem,
  clear: clearItems,
};

function sendJson(res, payload, status = 200) {
  const body = JSON.stringify(payload ?? null);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on("data", (chunk) => {
      if (done) return;
      // Over the cap: stop buffering but keep draining, so the 413 is written
      // to a request the peer has finished sending instead of a reset socket.
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return finish({ payload: null, tooLarge: true });
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (text === "") return finish({ payload: {}, tooLarge: false });
      try {
        const parsed = JSON.parse(text);
        finish({ payload: parsed !== null && typeof parsed === "object" ? parsed : {}, tooLarge: false });
      } catch {
        finish({ payload: {}, tooLarge: false });
      }
    });
    req.on("error", () => finish({ payload: {}, tooLarge }));
    req.on("aborted", () => finish({ payload: {}, tooLarge }));
  });
}

function queryOf(url) {
  const out = {};
  for (const [key, value] of url.searchParams.entries()) out[key] = value;
  return out;
}

async function handleRequest(ctx, req, res) {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) {
    sendJson(res, { ok: false, error: "only local requests are accepted" }, 403);
    return;
  }
  let url;
  try {
    url = new URL(req.url ?? "/", "http://127.0.0.1");
  } catch {
    sendJson(res, { ok: false, error: "bad request url" }, 400);
    return;
  }
  const action = url.pathname
    .slice(ROUTE.length)
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  const method = (req.method ?? "GET").toUpperCase();

  if (action === "" || action === "health") {
    if (method !== "GET") {
      sendJson(res, { ok: false, error: `method not allowed: ${method}; use GET` }, 405);
      return;
    }
    sendJson(res, {
      ok: true,
      plugin: "dsh-launch-buttons",
      version: "0.2.0",
      route: ROUTE,
      strategy: "multi-item",
      storePath: STORE_FILE(),
      legacyStorePath: LEGACY_STORE_FILE(),
      maxItems: MAX_ITEMS_PER_BUCKET,
      builtinId: BUILTIN_ID,
    });
    return;
  }

  // Dispatch on the action first so a known action reached with the wrong verb
  // answers 405 rather than pretending the action does not exist.
  const getHandler = GET_ACTIONS[action];
  const postHandler = POST_ACTIONS[action];
  if (getHandler === undefined && postHandler === undefined) {
    sendJson(res, { ok: false, error: `unknown action: ${action}` }, 404);
    return;
  }

  if (getHandler !== undefined) {
    if (method !== "GET") {
      sendJson(res, { ok: false, error: `method not allowed: ${method}; use GET` }, 405);
      return;
    }
    const payload = await getHandler(ctx, queryOf(url));
    sendJson(res, payload, payload?.ok === false ? 400 : 200);
    return;
  }

  if (method !== "POST") {
    sendJson(res, { ok: false, error: `method not allowed: ${method}; use POST` }, 405);
    return;
  }
  const body = await readJsonBody(req);
  if (body.tooLarge === true) {
    sendJson(res, { ok: false, error: `请求体过大（上限 ${MAX_BODY_BYTES} 字节）` }, 413);
    return;
  }
  const payload = await postHandler(ctx, body.payload);
  sendJson(res, payload, payload?.ok === false ? 400 : 200);
}

export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "prefix",
        path: ROUTE,
        handler: (req, res) => {
          handleRequest(ctx, req, res).catch((error) => {
            try {
              sendJson(res, { ok: false, error: error?.message ?? String(error) }, 500);
            } catch {
              /* the socket is gone */
            }
          });
        },
      }),
    "dsh-launch-buttons: launch endpoints",
  );
}
