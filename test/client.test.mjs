/**
 * Contract tests for the client half: the module-loader id, the `slots`
 * injection, the seat it registers into, and the CSS it injects.
 *
 * Nothing renders here - only `apply()` runs - so react/react-dom are stubs.
 *
 * Run (from the plugin directory):
 *   node --test test/client.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

const loaded = [];
const appendedStyles = [];

globalThis.window = { __ModuleLoader__: { load: (definition) => loaded.push(definition) } };
globalThis.document = {
  head: { append: (node) => appendedStyles.push(node) },
  createElement: () => ({
    dataset: {},
    textContent: "",
    remove() {
      appendedStyles.length = 0;
    },
  }),
};

const REACT_STUB = {
  createElement: () => null,
  Fragment: { toString: () => "Fragment" },
  useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
  useCallback: (callback) => callback,
  useEffect: () => {},
};

await import("../lib/client.js");

test("the client registers itself under the package name", () => {
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, "dsh-launch-buttons");
});

test("apply injects its styles and registers into the composer", () => {
  const moduleExports = loaded[0].factory((request) => {
    if (request === "react") return REACT_STUB;
    throw new Error(`unexpected require: ${request}`);
  });

  assert.deepEqual(moduleExports.inject, ["slots"]);
  assert.equal(typeof moduleExports.apply, "function");
  assert.equal(typeof moduleExports.LaunchButton, "function");

  const injected = [];
  const registered = [];
  const ctx = {
    effect(callback) {
      return callback();
    },
    get() {
      return undefined;
    },
    slots: {
      inject(name, callback) {
        injected.push(name);
        callback();
      },
      register(definition, component) {
        registered.push({ definition, component });
        return () => {};
      },
    },
  };

  moduleExports.apply(ctx);

  assert.equal(appendedStyles.length, 1);
  assert.match(appendedStyles[0].textContent, /\.dsh-lb-button/);
  assert.match(appendedStyles[0].textContent, /\.dsh-lb-menu/);
  assert.match(appendedStyles[0].textContent, /\.dsh-lb-panel/);
  assert.deepEqual(injected, ["conversation.input.right"]);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].definition.id, "dsh-launch-buttons");
  assert.equal(registered[0].definition.name, "conversation.input.right");
  assert.equal(registered[0].definition.order, 20);
  assert.equal(registered[0].component, moduleExports.LaunchButton);
});

test("the workspace picker is resolved lazily and tolerates a missing provider", () => {
  const moduleExports = loaded[0].factory((request) => {
    if (request === "react") return REACT_STUB;
    throw new Error(`unexpected require: ${request}`);
  });

  assert.equal(moduleExports.resolveUiWorkspace(), undefined);
  moduleExports._setClientCtx({ get: () => ({ pickDirectory: async () => "C:\\picked" }) });
  assert.equal(typeof moduleExports.resolveUiWorkspace().pickDirectory, "function");
  moduleExports._setClientCtx({
    get: () => {
      throw new Error('cannot get property "uiWorkspace" without inject');
    },
  });
  assert.equal(moduleExports.resolveUiWorkspace(), undefined);
});
