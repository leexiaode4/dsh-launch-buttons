/**
 * Unit tests for the pure half of dsh-launch-buttons.
 *
 * Run (from the plugin directory):
 *   node --test test/core.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  BUILTIN_ID,
  MAX_ITEMS_PER_BUCKET,
  SCOPE,
  STORE_VERSION,
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
  openerFor,
  resolveDefaultItem,
  withDefaultId,
  withItem,
  withItemPatch,
  withoutItem,
  workspaceKey,
} from "../lib/core.js";

const GONE = { exists: false, isDirectory: false, isFile: false };
const DIR = { exists: true, isDirectory: true, isFile: false };
const FILE = { exists: true, isDirectory: false, isFile: true };

const WS = "C:\\Projects\\demo";

/* ─────────────────────────── path helpers ─────────────────────────── */

test("isAbsolutePath accepts drive, UNC and posix roots", () => {
  assert.equal(isAbsolutePath("C:\\Games\\a.exe"), true);
  assert.equal(isAbsolutePath("d:/x/y"), true);
  assert.equal(isAbsolutePath("\\\\server\\share"), true);
  assert.equal(isAbsolutePath("/usr/local/bin"), true);
});

test("isAbsolutePath rejects relative, empty and non-strings", () => {
  assert.equal(isAbsolutePath("games\\a.exe"), false);
  assert.equal(isAbsolutePath("   "), false);
  assert.equal(isAbsolutePath(""), false);
  assert.equal(isAbsolutePath(null), false);
  assert.equal(isAbsolutePath(42), false);
});

test("extensionOf looks at the last segment only", () => {
  assert.equal(extensionOf("C:\\a.b\\tool.EXE"), ".exe");
  assert.equal(extensionOf("C:\\x\\y\\note.txt"), ".txt");
  assert.equal(extensionOf("C:\\dir.name\\plain"), "");
  assert.equal(extensionOf("C:\\x\\.hidden"), "");
});

test("workspaceKey unifies separators and case", () => {
  assert.equal(workspaceKey("C:\\Projects\\Demo\\"), "c:\\projects\\demo");
  assert.equal(workspaceKey("C:/Projects/Demo"), "c:\\projects\\demo");
  assert.equal(workspaceKey("   "), null);
  assert.equal(workspaceKey(null), null);
});

/* ─────────────────────────── classification ─────────────────────────── */

test("classifyTarget follows existence, directory and extension", () => {
  assert.equal(classifyTarget("C:\\gone", GONE, "win32"), TARGET_KIND.MISSING);
  assert.equal(classifyTarget("C:\\gone", null, "win32"), TARGET_KIND.MISSING);
  assert.equal(classifyTarget("C:\\dir", DIR, "win32"), TARGET_KIND.DIRECTORY);
  assert.equal(classifyTarget("C:\\dir", FILE, "win32"), TARGET_KIND.SHELL);
  assert.equal(classifyTarget("C:\\a.exe", FILE, "win32"), TARGET_KIND.EXECUTABLE);
  assert.equal(classifyTarget("C:\\a.scr", FILE, "win32"), TARGET_KIND.EXECUTABLE);
  assert.equal(classifyTarget("C:\\a.bat", FILE, "win32"), TARGET_KIND.SHELL);
});

test("classifyTarget uses the executable bit on POSIX", () => {
  const plain = { exists: true, isDirectory: false, isFile: true, mode: 0o644 };
  const exec = { exists: true, isDirectory: false, isFile: true, mode: 0o755 };
  assert.equal(classifyTarget("/home/me/run", plain, "linux"), TARGET_KIND.SHELL);
  assert.equal(classifyTarget("/home/me/run", exec, "linux"), TARGET_KIND.EXECUTABLE);
  assert.equal(classifyTarget("/home/me/run", exec, "darwin"), TARGET_KIND.EXECUTABLE);
  // Without a mode the extension rule still decides, as on Windows.
  assert.equal(
    classifyTarget("/home/me/run", { exists: true, isFile: true }, "linux"),
    TARGET_KIND.SHELL,
  );
});

test("buildLaunchPlan hands folders and shell files to explorer", () => {
  assert.deepEqual(buildLaunchPlan("C:\\Projects", TARGET_KIND.DIRECTORY, "win32"), {
    mode: "shell-open",
    command: "explorer.exe",
    args: ["C:\\Projects"],
  });
  assert.deepEqual(buildLaunchPlan("C:\\a.bat", TARGET_KIND.SHELL, "win32"), {
    mode: "shell-open",
    command: "explorer.exe",
    args: ["C:\\a.bat"],
  });
});

test("buildLaunchPlan uses the platform opener", () => {
  assert.equal(openerFor("win32"), "explorer.exe");
  assert.equal(openerFor("darwin"), "open");
  assert.equal(openerFor("linux"), "xdg-open");
  assert.equal(openerFor("freebsd"), "xdg-open");
  assert.deepEqual(buildLaunchPlan("/Users/me/Projects", TARGET_KIND.DIRECTORY, "darwin"), {
    mode: "shell-open",
    command: "open",
    args: ["/Users/me/Projects"],
  });
  assert.deepEqual(buildLaunchPlan("/home/me/notes.txt", TARGET_KIND.SHELL, "linux"), {
    mode: "shell-open",
    command: "xdg-open",
    args: ["/home/me/notes.txt"],
  });
});

test("buildLaunchPlan never routes paths through cmd", () => {
  // `& | ^ % !` in a path would be a second command for cmd.exe /c start.
  for (const [target, kind] of [
    ["C:\\a&b\\dir", TARGET_KIND.DIRECTORY],
    ["C:\\a&b.bat", TARGET_KIND.SHELL],
  ]) {
    const plan = buildLaunchPlan(target, kind, "win32");
    assert.equal(plan.command, "explorer.exe");
    assert.deepEqual(plan.args, [target]);
  }
});

test("buildLaunchPlan spawns executables directly", () => {
  assert.deepEqual(buildLaunchPlan("C:\\a.exe", TARGET_KIND.EXECUTABLE, "win32"), {
    mode: "exec",
    command: "C:\\a.exe",
    args: [],
  });
  assert.deepEqual(buildLaunchPlan("/usr/local/bin/tool", TARGET_KIND.EXECUTABLE, "linux"), {
    mode: "exec",
    command: "/usr/local/bin/tool",
    args: [],
  });
});

test("buildLaunchPlan refuses empty, relative and quoted targets", () => {
  assert.throws(() => buildLaunchPlan("", TARGET_KIND.DIRECTORY, "win32"), /empty/);
  assert.throws(() => buildLaunchPlan("a.exe", TARGET_KIND.EXECUTABLE, "win32"), /absolute/);
  assert.throws(
    () => buildLaunchPlan('C:\\a"b.exe', TARGET_KIND.EXECUTABLE, "win32"),
    /illegal/,
  );
});

/* ─────────────────────────── ids & store ─────────────────────────── */

test("makeItemId is deterministic for a given clock and roll", () => {
  const id = makeItemId(1_700_000_000_000, () => 0.5);
  assert.equal(id, makeItemId(1_700_000_000_000, () => 0.5));
  assert.match(id, /^it-[0-9a-z]+-[0-9a-z]+$/);
  assert.notEqual(id, makeItemId(1_700_000_000_001, () => 0.5));
});

test("normalizeStore tolerates junk", () => {
  assert.deepEqual(normalizeStore(null), emptyStore());
  assert.deepEqual(normalizeStore("nope"), emptyStore());
  assert.deepEqual(normalizeStore({ version: 2, sessions: [], workspaces: 7 }), emptyStore());
  assert.equal(emptyStore().version, STORE_VERSION);
});

test("normalizeStore migrates a v1 single binding into one item", () => {
  const legacy = {
    version: 1,
    sessions: { s1: { path: "C:\\a.exe", label: "A", at: "2026-01-01" } },
    workspaces: { "c:\\projects\\demo": { path: "C:\\Projects\\Demo", label: null, at: null } },
  };
  const store = normalizeStore(legacy);
  const session = bucketOf(store, SCOPE.SESSION, "s1");
  assert.equal(session.items.length, 1);
  assert.equal(session.items[0].path, "C:\\a.exe");
  assert.equal(session.items[0].label, "A");
  assert.equal(session.defaultId, session.items[0].id);
  const workspace = bucketOf(store, SCOPE.WORKSPACE, "c:\\projects\\demo");
  assert.equal(workspace.items.length, 1);
  assert.equal(workspace.defaultId, workspace.items[0].id);
});

test("normalizeStore drops relative paths and duplicate ids", () => {
  const store = normalizeStore({
    version: 2,
    sessions: {
      s1: {
        items: [
          { id: "a", path: "relative\\x.exe" },
          { id: "b", path: "C:\\ok.exe" },
          { id: "b", path: "C:\\dupe.exe" },
        ],
        defaultId: "b",
      },
    },
  });
  const bucket = bucketOf(store, SCOPE.SESSION, "s1");
  assert.deepEqual(bucket.items.map((item) => item.path), ["C:\\ok.exe"]);
  assert.equal(bucket.defaultId, "b");
});

test("normalizeStore keeps a bucket that only pins the built-in workspace", () => {
  const store = normalizeStore({
    version: 2,
    sessions: { s1: { items: [], defaultId: BUILTIN_ID } },
  });
  assert.equal(bucketOf(store, SCOPE.SESSION, "s1").defaultId, BUILTIN_ID);
  const dropped = normalizeStore({ version: 2, sessions: { s1: { items: [], defaultId: "ghost" } } });
  assert.equal(bucketOf(dropped, SCOPE.SESSION, "s1").defaultId, null);
});

test("normalizeStore caps the number of items", () => {
  const items = Array.from({ length: MAX_ITEMS_PER_BUCKET + 5 }, (unused, index) => ({
    id: `i${index}`,
    path: `C:\\file${index}.exe`,
  }));
  const store = normalizeStore({ version: 2, sessions: { s1: { items, defaultId: null } } });
  assert.equal(bucketOf(store, SCOPE.SESSION, "s1").items.length, MAX_ITEMS_PER_BUCKET);
});

/* ─────────────────────────── mutations ─────────────────────────── */

function baseStore() {
  return normalizeStore({ version: 2, sessions: {}, workspaces: {} });
}

test("withItem appends without touching the original store", () => {
  const store = baseStore();
  const next = withItem(store, SCOPE.SESSION, "s1", { id: "a", label: null, path: "C:\\a.exe", at: null });
  assert.equal(bucketOf(store, SCOPE.SESSION, "s1").items.length, 0);
  assert.equal(bucketOf(next, SCOPE.SESSION, "s1").items.length, 1);
});

test("withItem refuses to grow past the limit", () => {
  let store = baseStore();
  for (let index = 0; index < MAX_ITEMS_PER_BUCKET; index += 1) {
    store = withItem(store, SCOPE.SESSION, "s1", { id: `i${index}`, path: `C:\\f${index}.exe`, label: null, at: null });
  }
  assert.equal(withItem(store, SCOPE.SESSION, "s1", { id: "x", path: "C:\\x.exe", label: null, at: null }), null);
});

test("withItemPatch updates label and path only for a known id", () => {
  let store = withItem(baseStore(), SCOPE.SESSION, "s1", { id: "a", label: "A", path: "C:\\a.exe", at: null });
  store = withItemPatch(store, SCOPE.SESSION, "s1", "a", { label: "B", path: "C:\\b.exe" });
  const item = bucketOf(store, SCOPE.SESSION, "s1").items[0];
  assert.equal(item.label, "B");
  assert.equal(item.path, "C:\\b.exe");
  assert.equal(withItemPatch(store, SCOPE.SESSION, "s1", "ghost", { label: "x" }), null);
  const cleared = withItemPatch(store, SCOPE.SESSION, "s1", "a", { label: "" });
  assert.equal(bucketOf(cleared, SCOPE.SESSION, "s1").items[0].label, null);
});

test("withoutItem drops the item and forgets a default that pointed at it", () => {
  let store = withItem(baseStore(), SCOPE.SESSION, "s1", { id: "a", label: null, path: "C:\\a.exe", at: null });
  store = withDefaultId(store, SCOPE.SESSION, "s1", "a");
  assert.equal(bucketOf(store, SCOPE.SESSION, "s1").defaultId, "a");
  const next = withoutItem(store, SCOPE.SESSION, "s1", "a");
  assert.equal(bucketOf(next, SCOPE.SESSION, "s1").items.length, 0);
  assert.equal(bucketOf(next, SCOPE.SESSION, "s1").defaultId, null);
  assert.equal(withoutItem(store, SCOPE.SESSION, "s1", "ghost"), null);
});

test("withDefaultId accepts an item or the built-in workspace, rejects ghosts", () => {
  let store = withItem(baseStore(), SCOPE.SESSION, "s1", { id: "a", label: null, path: "C:\\a.exe", at: null });
  store = withDefaultId(store, SCOPE.SESSION, "s1", "a");
  assert.equal(bucketOf(store, SCOPE.SESSION, "s1").defaultId, "a");
  store = withDefaultId(store, SCOPE.SESSION, "s1", BUILTIN_ID);
  assert.equal(bucketOf(store, SCOPE.SESSION, "s1").defaultId, BUILTIN_ID);
  assert.equal(withDefaultId(store, SCOPE.SESSION, "s1", "ghost"), null);
});

test("clearScope wipes one scope or both", () => {
  let store = withItem(baseStore(), SCOPE.SESSION, "s1", { id: "a", label: null, path: "C:\\a.exe", at: null });
  store = withItem(store, SCOPE.WORKSPACE, workspaceKey(WS), { id: "b", label: null, path: "C:\\b.exe", at: null });
  const sessionOnly = clearScope(store, "s1", WS, SCOPE.SESSION);
  assert.equal(bucketOf(sessionOnly, SCOPE.SESSION, "s1").items.length, 0);
  assert.equal(bucketOf(sessionOnly, SCOPE.WORKSPACE, workspaceKey(WS)).items.length, 1);
  const all = clearScope(store, "s1", WS, "all");
  assert.equal(bucketOf(all, SCOPE.SESSION, "s1").items.length, 0);
  assert.equal(bucketOf(all, SCOPE.WORKSPACE, workspaceKey(WS)).items.length, 0);
});

/* ─────────────────────────── resolution ─────────────────────────── */

function storeWithSessionAndWorkspace() {
  let store = withItem(baseStore(), SCOPE.SESSION, "s1", { id: "s", label: "Session", path: "C:\\s.exe", at: null });
  store = withItem(store, SCOPE.WORKSPACE, workspaceKey(WS), { id: "w", label: "Workspace", path: "C:\\w.exe", at: null });
  return store;
}

test("listItems orders session, workspace, then the built-in row", () => {
  const { items, defaultId } = listItems(storeWithSessionAndWorkspace(), "s1", WS);
  assert.deepEqual(items.map((item) => item.scope), [SCOPE.SESSION, SCOPE.WORKSPACE, SCOPE.BUILTIN]);
  assert.equal(items[2].id, BUILTIN_ID);
  assert.equal(items[2].path, WS);
  assert.equal(defaultId, BUILTIN_ID);
});

test("listItems has no built-in row without a workspace, and always has a default", () => {
  const { items, defaultId } = listItems(storeWithSessionAndWorkspace(), "s1", null);
  // 没有工作区目录就没有工作区分桶可合并（工作区条目按目录区分，无法凭空认领），
  // 也就没有内置的「工作区」行；剩下的会话行仍要能当默认项。
  assert.deepEqual(items.map((item) => item.scope), [SCOPE.SESSION]);
  assert.equal(items[0].id, "s");
  assert.equal(defaultId, "s");
  const empty = listItems(baseStore(), "s1", null);
  assert.deepEqual(empty.items, []);
  assert.equal(empty.defaultId, null);
});

test("the session default wins over the workspace default", () => {
  let store = storeWithSessionAndWorkspace();
  store = withDefaultId(store, SCOPE.WORKSPACE, workspaceKey(WS), "w");
  store = withDefaultId(store, SCOPE.SESSION, "s1", "s");
  assert.equal(listItems(store, "s1", WS).defaultId, "s");
  assert.equal(resolveDefaultItem(store, "s1", WS).id, "s");
});

test("a workspace default applies to another conversation of the same workspace", () => {
  let store = storeWithSessionAndWorkspace();
  store = withDefaultId(store, SCOPE.WORKSPACE, workspaceKey(WS), "w");
  const { items, defaultId } = listItems(store, "s2", WS);
  assert.deepEqual(items.map((item) => item.id), ["w", BUILTIN_ID]);
  assert.equal(defaultId, "w");
});

test("a vanished default falls back to the first item, then to the workspace", () => {
  const store = withItem(baseStore(), SCOPE.SESSION, "s1", { id: "s", label: null, path: "C:\\s.exe", at: null });
  const pinned = withDefaultId(store, SCOPE.SESSION, "s1", "ghost");
  assert.equal(pinned, null);
  assert.equal(listItems(store, "s1", WS).defaultId, BUILTIN_ID);
  assert.equal(resolveDefaultItem(baseStore(), "s1", WS).id, BUILTIN_ID);
  assert.equal(resolveDefaultItem(baseStore(), "s1", null), null);
});

test("findItem searches both scopes and the built-in row", () => {
  const store = storeWithSessionAndWorkspace();
  assert.equal(findItem(store, "s1", WS, "s").scope, SCOPE.SESSION);
  assert.equal(findItem(store, "s1", WS, "w").scope, SCOPE.WORKSPACE);
  assert.equal(findItem(store, "s1", WS, BUILTIN_ID).path, WS);
  assert.equal(findItem(store, "s1", WS, "ghost"), null);
  assert.equal(findItem(store, "s1", WS, ""), null);
});

/* ─────────────────────────── loopback ─────────────────────────── */

test("isLoopbackAddress only trusts this machine", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("127.0.0.55"), true);
  assert.equal(isLoopbackAddress("192.168.1.10"), false);
  assert.equal(isLoopbackAddress("::ffff:8.8.8.8"), false);
  assert.equal(isLoopbackAddress(undefined), false);
});
