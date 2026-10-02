/**
 * dsh-launch-buttons - pure host-side logic (the multi-item copy of
 * `dsh-launch-button`).
 *
 * Everything that can be decided without DSH, without `node:fs`, and without
 * process state lives here so `test/core.test.mjs` can drive it with plain
 * objects:
 *
 *  - what counts as a launchable target        (classifyTarget / buildLaunchPlan),
 *  - the shape of the store, including the     (normalizeStore / makeItemId)
 *    migration from the v1 single-binding file,
 *  - which item a plain left click launches.   (listItems / resolveDefaultItem)
 *
 * The store keeps the original two scopes, but every scope now holds a LIST of
 * launch items plus one `defaultId`:
 *
 *   { version: 2,
 *     sessions:   { <sessionId>:   { items: [item], defaultId: string|null } },
 *     workspaces: { <workspaceKey>:{ items: [item], defaultId: string|null } } }
 *
 * `defaultId === BUILTIN_ID` means "the workspace directory itself", which is
 * also what an empty store resolves to: a fresh conversation launches its
 * workspace directory with no configuration at all.
 *
 * A session bucket is consulted first, then the bucket of the workspace the
 * session lives in, then the built-in workspace item. When the default cannot
 * be found (it was removed, or the conversation moved) the first available item
 * wins, so a left click always has something sane to launch.
 */

/** How a launch target is treated. */
export const TARGET_KIND = {
  DIRECTORY: "directory",
  EXECUTABLE: "executable",
  SHELL: "shell",
  MISSING: "missing",
};

/** Which scope an item lives in. */
export const SCOPE = {
  SESSION: "session",
  WORKSPACE: "workspace",
  BUILTIN: "builtin",
};

/** `defaultId` value standing for the conversation's own workspace directory. */
export const BUILTIN_ID = "workspace";

export const STORE_VERSION = 2;
export const MAX_ITEMS_PER_BUCKET = 24;

const EXECUTABLE_EXT = new Set([".exe", ".com", ".scr"]);
/** Characters that could break an argv entry handed to the OS. */
const FORBIDDEN_IN_PATH = /["\r\n\0]/;

/**
 * Windows drive path, UNC path, or a POSIX path. Only these are launchable:
 * a relative path would resolve against whatever cwd the host happens to have.
 */
export function isAbsolutePath(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed === "") return false;
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return true;
  if (trimmed.startsWith("\\\\")) return true;
  if (trimmed.startsWith("/")) return true;
  return false;
}

/** Lowercased extension including the dot, or "" when there is none. */
export function extensionOf(value) {
  if (typeof value !== "string") return "";
  const base = value.trim().replace(/[\\/]+$/, "");
  const name = base.slice(Math.max(base.lastIndexOf("\\"), base.lastIndexOf("/")) + 1);
  const index = name.lastIndexOf(".");
  if (index <= 0) return "";
  return name.slice(index).toLowerCase();
}

/**
 * @param {string} path
 * @param {{exists?: boolean, isDirectory?: boolean, isFile?: boolean}|null|undefined} stat
 */
export function classifyTarget(path, stat, platform = process.platform) {
  if (!stat || stat.exists !== true) return TARGET_KIND.MISSING;
  if (stat.isDirectory === true) return TARGET_KIND.DIRECTORY;
  if (EXECUTABLE_EXT.has(extensionOf(path))) return TARGET_KIND.EXECUTABLE;
  // On POSIX the extension says nothing; the executable bit does. Only used
  // when the caller's stat result carries a mode, so the Windows path is
  // unchanged.
  if (
    platform !== "win32" &&
    stat.isFile === true &&
    typeof stat.mode === "number" &&
    (stat.mode & 0o111) !== 0
  ) {
    return TARGET_KIND.EXECUTABLE;
  }
  return TARGET_KIND.SHELL;
}

/** Command that opens a folder or document with the platform's default handler. */
export function openerFor(platform) {
  if (platform === "darwin") return "open";
  if (platform === "win32") return "explorer.exe";
  return "xdg-open";
}

/**
 * Turn a target into the argv to spawn. Kept separate from `spawn` itself so
 * the decision is unit-testable and the host can explain a refusal.
 *
 * @returns {{mode: "shell-open"|"exec", command: string, args: string[]}}
 */
export function buildLaunchPlan(path, kind, platform = process.platform) {
  if (typeof path !== "string" || path.trim() === "") {
    throw new Error("launch target is empty");
  }
  const target = path.trim();
  if (!isAbsolutePath(target)) {
    throw new Error(`launch target must be an absolute path: ${target}`);
  }
  if (FORBIDDEN_IN_PATH.test(target)) {
    throw new Error("launch target contains an illegal character");
  }
  if (kind === TARGET_KIND.DIRECTORY || kind === TARGET_KIND.SHELL) {
    // `explorer.exe <path>` (Windows), `open <path>` (macOS) and
    // `xdg-open <path>` (Linux) open a folder or a document with its registered
    // application, exactly like a double click. Deliberately not
    // `cmd.exe /c start`: cmd re-parses the argument, so a path containing
    // `& | ^ < > % !` would run a second command, and cmd.exe cannot be given a
    // path that is safely quoted from here (libuv only quotes argv entries
    // containing spaces or quotes). The opener takes the path as a path.
    return { mode: "shell-open", command: openerFor(platform), args: [target] };
  }
  return { mode: "exec", command: target, args: [] };
}

/** Stable key for a workspace directory: separators unified, no trailing slash. */
export function workspaceKey(path) {
  if (typeof path !== "string") return null;
  const trimmed = path.trim();
  if (trimmed === "") return null;
  return trimmed.replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();
}

/** Store key for a scope. `builtin` has no bucket of its own. */
function bucketKeyFor(scope, key) {
  if (scope !== SCOPE.SESSION && scope !== SCOPE.WORKSPACE) return null;
  if (typeof key !== "string" || key === "") return null;
  return key;
}

export function emptyStore() {
  return { version: STORE_VERSION, sessions: {}, workspaces: {} };
}

/**
 * Accepts a v2 store, a v1 store (one binding per scope, `{path,label,at}`),
 * or junk, and always returns a usable v2 store.
 */
export function normalizeStore(raw) {
  const store = emptyStore();
  if (raw === null || typeof raw !== "object") return store;
  for (const scope of [SCOPE.SESSION, SCOPE.WORKSPACE]) {
    const table = raw[scope === SCOPE.SESSION ? "sessions" : "workspaces"];
    if (table === null || typeof table !== "object" || Array.isArray(table)) continue;
    for (const [key, value] of Object.entries(table)) {
      if (typeof key !== "string" || key === "") continue;
      const bucket = normalizeBucket(value);
      if (bucket === null) continue;
      store[scope === SCOPE.SESSION ? "sessions" : "workspaces"][key] = bucket;
    }
  }
  return store;
}

function normalizeBucket(value) {
  if (value === null || typeof value !== "object") return null;
  // v1 stored exactly one binding in the bucket itself.
  if (!Array.isArray(value.items)) {
    const legacy = normalizeItem(value, "it-legacy-0");
    if (legacy === null) return null;
    return { items: [legacy], defaultId: legacy.id };
  }
  const items = [];
  const seen = new Set();
  for (const candidate of value.items) {
    if (items.length >= MAX_ITEMS_PER_BUCKET) break;
    const item = normalizeItem(candidate, null);
    if (item === null || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  const wanted = typeof value.defaultId === "string" && value.defaultId !== "" ? value.defaultId : null;
  // A bucket may legitimately hold no items as long as it pins the built-in
  // workspace as the default ("all my other items are gone, but Enter opens the
  // workspace" must survive a reload).
  const defaultId = wanted !== null && (seen.has(wanted) || wanted === BUILTIN_ID) ? wanted : null;
  if (items.length === 0 && defaultId === null) return null;
  return { items, defaultId };
}

function normalizeItem(value, fallbackId) {
  if (value === null || typeof value !== "object") return null;
  const id = typeof value.id === "string" && value.id.trim() !== "" ? value.id.trim() : fallbackId;
  if (id === null) return null;
  const path = typeof value.path === "string" ? value.path.trim() : "";
  if (!isAbsolutePath(path)) return null;
  const label = typeof value.label === "string" && value.label.trim() !== "" ? value.label.trim() : null;
  const at = typeof value.at === "string" && value.at !== "" ? value.at : null;
  return { id, label, path, at };
}

/**
 * `it-<base36 time>-<base36 noise>`. `random` is injected so tests stay stable.
 */
export function makeItemId(at, random) {
  const stamp = Number.isFinite(at) ? Math.floor(at).toString(36) : Date.now().toString(36);
  const roll = typeof random === "function" ? random() : Math.random();
  const safe = Number.isFinite(roll) ? Math.min(Math.max(roll, 0), 0.999999999) : 0;
  const noise = Math.floor(safe * 0x100000000).toString(36).slice(-6);
  return `it-${stamp}-${noise}`;
}

function cloneStore(store) {
  const next = emptyStore();
  if (store === null || typeof store !== "object") return next;
  for (const scope of [SCOPE.SESSION, SCOPE.WORKSPACE]) {
    const from = scope === SCOPE.SESSION ? store.sessions : store.workspaces;
    const to = scope === SCOPE.SESSION ? next.sessions : next.workspaces;
    if (from === null || typeof from !== "object") continue;
    for (const [key, bucket] of Object.entries(from)) {
      if (bucket === null || typeof bucket !== "object") continue;
      to[key] = {
        items: Array.isArray(bucket.items) ? bucket.items.map((item) => ({ ...item })) : [],
        defaultId: typeof bucket.defaultId === "string" ? bucket.defaultId : null,
      };
    }
  }
  return next;
}

/** Read one bucket, never null. */
export function bucketOf(store, scope, key) {
  const safe = store ?? emptyStore();
  const table = scope === SCOPE.SESSION ? safe.sessions : scope === SCOPE.WORKSPACE ? safe.workspaces : null;
  const bucketKey = bucketKeyFor(scope, key);
  if (table === null || bucketKey === null) return { items: [], defaultId: null };
  const bucket = table[bucketKey];
  if (bucket === null || typeof bucket !== "object") return { items: [], defaultId: null };
  return {
    items: Array.isArray(bucket.items) ? bucket.items : [],
    defaultId: typeof bucket.defaultId === "string" ? bucket.defaultId : null,
  };
}

function putBucket(store, scope, key, bucket) {
  if (scope === SCOPE.SESSION) store.sessions[key] = bucket;
  else if (scope === SCOPE.WORKSPACE) store.workspaces[key] = bucket;
  return store;
}

/** Append an item. Returns the item, or null when the bucket is full. */
export function withItem(store, scope, key, item, limit = MAX_ITEMS_PER_BUCKET) {
  const bucketKey = bucketKeyFor(scope, key);
  if (bucketKey === null) return null;
  const next = cloneStore(store);
  const current = bucketOf(next, scope, bucketKey);
  if (current.items.length >= limit) return null;
  const items = [...current.items, { ...item }];
  putBucket(next, scope, bucketKey, { items, defaultId: current.defaultId });
  return next;
}

/** Patch `label` / `path` of one item. Returns the new store, or null when unknown. */
export function withItemPatch(store, scope, key, id, patch) {
  const bucketKey = bucketKeyFor(scope, key);
  if (bucketKey === null) return null;
  const next = cloneStore(store);
  const current = bucketOf(next, scope, bucketKey);
  const index = current.items.findIndex((item) => item.id === id);
  if (index < 0) return null;
  const items = current.items.map((item, at) => {
    if (at !== index) return item;
    const merged = { ...item };
    if (patch !== null && typeof patch === "object") {
      if (typeof patch.label === "string") merged.label = patch.label.trim() === "" ? null : patch.label.trim();
      else if (patch.label === null) merged.label = null;
      if (typeof patch.path === "string" && patch.path.trim() !== "") merged.path = patch.path.trim();
    }
    return merged;
  });
  putBucket(next, scope, bucketKey, { items, defaultId: current.defaultId });
  return next;
}

/** Drop one item; a `defaultId` pointing at it falls back to the built-in item. */
export function withoutItem(store, scope, key, id) {
  const bucketKey = bucketKeyFor(scope, key);
  if (bucketKey === null) return null;
  const next = cloneStore(store);
  const current = bucketOf(next, scope, bucketKey);
  if (!current.items.some((item) => item.id === id)) return null;
  const items = current.items.filter((item) => item.id !== id);
  const defaultId = current.defaultId === id ? null : current.defaultId;
  if (items.length === 0 && defaultId === null) {
    if (scope === SCOPE.SESSION) delete next.sessions[bucketKey];
    else delete next.workspaces[bucketKey];
    return next;
  }
  putBucket(next, scope, bucketKey, { items, defaultId });
  return next;
}

/** Pin `defaultId` for a scope. `id` may be {@link BUILTIN_ID}. */
export function withDefaultId(store, scope, key, id) {
  const bucketKey = bucketKeyFor(scope, key);
  if (bucketKey === null) return null;
  const next = cloneStore(store);
  const current = bucketOf(next, scope, bucketKey);
  const defaultId = typeof id === "string" && id !== "" ? id : null;
  if (defaultId !== null && defaultId !== BUILTIN_ID && !current.items.some((item) => item.id === defaultId)) {
    return null;
  }
  putBucket(next, scope, bucketKey, { items: current.items, defaultId });
  return next;
}

/** Wipe one scope, or both with `scope: "all"`. */
export function clearScope(store, sessionId, workspacePath, scope) {
  const next = cloneStore(store);
  const key = workspaceKey(workspacePath);
  if ((scope === SCOPE.SESSION || scope === "all") && typeof sessionId === "string" && sessionId !== "") {
    delete next.sessions[sessionId];
  }
  if ((scope === SCOPE.WORKSPACE || scope === "all") && key !== null) {
    delete next.workspaces[key];
  }
  return next;
}

/**
 * The merged, ordered menu: this conversation's items, then the items bound to
 * the workspace, then the built-in workspace directory as the fallback row.
 *
 * @returns {{items: Array<{id,label,path,at,scope}>, defaultId: string|null}}
 */
export function listItems(store, sessionId, workspacePath) {
  const safe = store ?? emptyStore();
  const out = [];
  const sessionBucket = typeof sessionId === "string" && sessionId !== "" ? bucketOf(safe, SCOPE.SESSION, sessionId) : { items: [], defaultId: null };
  const key = workspaceKey(workspacePath);
  const workspaceBucket = key === null ? { items: [], defaultId: null } : bucketOf(safe, SCOPE.WORKSPACE, key);
  for (const item of sessionBucket.items) out.push({ ...item, scope: SCOPE.SESSION });
  for (const item of workspaceBucket.items) out.push({ ...item, scope: SCOPE.WORKSPACE });
  if (key !== null) {
    out.push({ id: BUILTIN_ID, label: "工作区", path: workspacePath, at: null, scope: SCOPE.BUILTIN });
  }
  const wanted = sessionBucket.defaultId ?? workspaceBucket.defaultId ?? BUILTIN_ID;
  let defaultId = out.some((item) => item.id === wanted) ? wanted : out.length > 0 ? out[0].id : null;
  return { items: out, defaultId };
}

/** The item a plain left click launches, or null when there is nothing at all. */
export function resolveDefaultItem(store, sessionId, workspacePath) {
  const { items, defaultId } = listItems(store, sessionId, workspacePath);
  if (defaultId === null) return null;
  return items.find((item) => item.id === defaultId) ?? items[0] ?? null;
}

/**
 * Look up one item by id across both scopes (session wins) and the built-in row.
 * `id === BUILTIN_ID` resolves to the workspace directory item.
 */
export function findItem(store, sessionId, workspacePath, id) {
  if (typeof id !== "string" || id === "") return null;
  const { items } = listItems(store, sessionId, workspacePath);
  return items.find((item) => item.id === id) ?? null;
}

/** True for connections that can only come from this machine. */
export function isLoopbackAddress(address) {
  if (typeof address !== "string") return false;
  let value = address.trim().toLowerCase();
  if (value.startsWith("::ffff:")) value = value.slice("::ffff:".length);
  if (value === "::1" || value === "127.0.0.1" || value === "localhost") return true;
  return value.startsWith("127.");
}
