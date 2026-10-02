/**
 * dsh-launch-buttons - client half (the multi-item copy of `dsh-launch-button`).
 *
 * One button in the composer (`conversation.input.right`):
 *
 *   left click   launch the default item (the workspace directory until you
 *                configure anything),
 *   right click  open the list of launch items,
 *   every row    left click launches that item, ★ pins it as the default,
 *                ⚙ (or a right click on the row) opens its own settings.
 *
 * All state lives on the host (`/dsh-launch-buttons`), never in localStorage,
 * so the sidebar/composer can be reloaded without losing anything.
 *
 * Only `react` may be required here; the UI is drawn with `createElement`,
 * `react-dom` is never needed (panels are fixed-position elements inside the
 * slot rather than portals), and colours come from the `--dsw-alias-*` tokens.
 */
if (typeof window !== "undefined" && window.__ModuleLoader__) {
  window.__ModuleLoader__.load({
    id: "dsh-launch-buttons",
    factory: (require) => {
      var module = { exports: {} };
      var exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

      let react = require("react");

      const h = react.createElement;
      const inject = ["slots"];
      const ROUTE = "/dsh-launch-buttons";

      const KIND_LABEL = {
        directory: "文件夹",
        executable: "程序",
        shell: "文件 · 用默认程序打开",
        missing: "路径不存在",
      };
      const SCOPE_LABEL = {
        session: "只绑定这个对话",
        workspace: "绑定整个工作区（该目录下的所有对话）",
        builtin: "当前工作区目录",
      };

      /**
       * Resolved lazily on purpose: the client entry points run in parallel, so
       * the uiWorkspace provider may still be LOADING while we apply, and
       * reading `ctx.uiWorkspace` (without `inject`) throws in the cordis proxy.
       */
      let clientCtx;
      function resolveUiWorkspace() {
        if (clientCtx === undefined || clientCtx === null) return undefined;
        try {
          return clientCtx.get?.("uiWorkspace") ?? undefined;
        } catch {
          return undefined;
        }
      }

      function messageOf(error) {
        if (error === null || error === undefined) return "未知错误";
        if (typeof error === "string") return error;
        if (typeof error.message === "string" && error.message !== "") return error.message;
        return String(error);
      }

      async function request(action, init) {
        const response = await fetch(`${ROUTE}/${action}`, { cache: "no-store", ...init });
        let payload = null;
        try {
          payload = await response.json();
        } catch {
          payload = null;
        }
        if (payload === null || typeof payload !== "object") {
          throw new Error(`启动项服务没有返回 JSON（HTTP ${response.status}）`);
        }
        if (payload.ok === false) throw new Error(payload.error ?? "启动项服务拒绝了这次操作");
        return payload;
      }

      function getJson(action, params) {
        const query = new URLSearchParams();
        for (const [key, value] of Object.entries(params ?? {})) {
          if (value === undefined || value === null || value === "") continue;
          query.set(key, String(value));
        }
        const suffix = query.toString() === "" ? "" : `?${query.toString()}`;
        return request(`${action}${suffix}`);
      }

      function postJson(action, body) {
        return request(action, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body ?? {}),
        });
      }

      /* ─────────────────────────── icons ─────────────────────────── */

      function svg(children, extra) {
        return h(
          "svg",
          {
            viewBox: "0 0 16 16",
            width: 15,
            height: 15,
            fill: "none",
            stroke: "currentColor",
            strokeWidth: 1.6,
            strokeLinecap: "round",
            strokeLinejoin: "round",
            "aria-hidden": true,
            focusable: false,
            ...(extra ?? {}),
          },
          children,
        );
      }

      function PlayIcon() {
        return svg(h("path", { d: "M5 3.4 12.2 8 5 12.6Z", fill: "currentColor", stroke: "none" }));
      }

      function SpinnerIcon() {
        return svg(h("circle", { cx: 8, cy: 8, r: 5.4, className: "dsh-lb-spin", strokeDasharray: "8 5" }));
      }

      function CheckIcon() {
        return svg(h("path", { d: "M3.5 8.6 6.6 11.7 12.5 4.9" }));
      }

      function CrossIcon() {
        return svg([h("path", { key: "a", d: "M4.2 4.2 11.8 11.8" }), h("path", { key: "b", d: "M11.8 4.2 4.2 11.8" })]);
      }

      function StarIcon(props) {
        const filled = props?.filled === true;
        return svg(
          h("path", {
            d: "M8 2.6 9.7 6.1 13.5 6.6 10.7 9.3 11.4 13.1 8 11.3 4.6 13.1 5.3 9.3 2.5 6.6 6.3 6.1Z",
            fill: filled ? "currentColor" : "none",
          }),
        );
      }

      function GearIcon() {
        return svg([
          h("circle", { key: "c", cx: 8, cy: 8, r: 2.4 }),
          h("path", { key: "p", d: "M8 1.9v2M8 12.1v2M1.9 8h2M12.1 8h2M3.7 3.7l1.4 1.4M10.9 10.9l1.4 1.4M12.3 3.7l-1.4 1.4M5.1 10.9l-1.4 1.4" }),
        ]);
      }

      function FolderIcon() {
        return svg(h("path", { d: "M1.9 4.3h4.2l1.2 1.7h6.8v6.1H1.9z" }));
      }

      function PlusIcon() {
        return svg([h("path", { key: "a", d: "M8 3.4v9.2" }), h("path", { key: "b", d: "M3.4 8h9.2" })]);
      }

      /* ───────────────────────── main button ───────────────────────── */

      function tooltipFor(state, flash) {
        const lines = [];
        if (flash) {
          lines.push(flash.ok ? `已启动：${flash.text}` : `启动失败：${flash.text}`);
        }
        if (state === null) {
          lines.push("正在读取启动项…");
        } else {
          const target = state.defaultItem;
          if (target === null) {
            lines.push("这个对话没有可启动的目标，右键打开启动项列表添加一个");
          } else {
            lines.push(`左键启动：${target.label}`);
            lines.push(target.path);
            if (!target.exists) lines.push("⚠ 这个路径现在不存在");
          }
          const count = Array.isArray(state.items) ? state.items.length : 0;
          lines.push(`右键：启动项列表（${count} 项）· 可新建、设为默认、单独设置`);
        }
        return lines.join("\n");
      }

      function buttonStateOf(state, pending, flash) {
        if (pending) return "pending";
        if (flash !== null && flash !== undefined) return flash.ok ? "ok" : "error";
        if (state === null || state.ok === false) return "idle";
        if (state.defaultItem !== null && state.defaultItem !== undefined && state.defaultItem.exists === false) {
          return "stale";
        }
        return "idle";
      }

      function LaunchButton(props) {
        const sessionId = props?.sessionId ?? null;
        const [state, setState] = react.useState(null);
        const [pending, setPending] = react.useState(false);
        const [flash, setFlash] = react.useState(null);
        const [view, setView] = react.useState(null);
        const [notice, setNotice] = react.useState(null);

        const refresh = react.useCallback(async () => {
          try {
            const data = await getJson("state", { sessionId });
            setState(data);
          } catch (error) {
            setState({ ok: false, error: messageOf(error), items: [], defaultId: null, defaultItem: null });
          }
        }, [sessionId]);

        react.useEffect(() => {
          void refresh();
        }, [refresh]);

        react.useEffect(() => {
          if (flash === null || flash === undefined) return undefined;
          const timer = setTimeout(() => setFlash(null), flash.ok ? 2400 : 6000);
          return () => clearTimeout(timer);
        }, [flash]);

        react.useEffect(() => {
          if (view !== null && view.kind === "menu") void refresh();
        }, [view, refresh]);

        const launch = react.useCallback(
          async (itemId) => {
            setPending(true);
            setView(null);
            try {
              const payload = await postJson("launch", itemId === undefined ? { sessionId } : { sessionId, itemId });
              setFlash({ ok: true, text: payload.label ?? payload.path });
              void refresh();
            } catch (error) {
              setFlash({ ok: false, text: messageOf(error) });
            } finally {
              setPending(false);
            }
          },
          [sessionId, refresh],
        );

        const setDefault = react.useCallback(
          async (item) => {
            try {
              const payload = await postJson("item/default", {
                sessionId,
                id: item.id,
                scope: item.scope === "workspace" ? "workspace" : "session",
              });
              setState(payload);
              // Report what the host will actually resolve: a pin on a
              // workspace item can still be shadowed by a session one.
              const effective = payload?.defaultItem ?? null;
              setNotice({
                ok: true,
                text: effective === null ? "已设为默认" : `默认启动项：${effective.label ?? effective.path}`,
              });
            } catch (error) {
              setNotice({ ok: false, text: messageOf(error) });
            }
          },
          [sessionId],
        );

        const clearItems = react.useCallback(async () => {
          try {
            const payload = await postJson("clear", { sessionId, scope: "session" });
            setState(payload);
            setNotice({ ok: true, text: "已清空这个对话的启动项" });
          } catch (error) {
            setNotice({ ok: false, text: messageOf(error) });
          }
        }, [sessionId]);

        const label = pending ? "启动中…" : "启动项";

        return h(
          react.Fragment,
          null,
          h(
            "button",
            {
              type: "button",
              className: "dsh-lb-button",
              "data-state": buttonStateOf(state, pending, flash),
              "aria-label": label,
              "aria-haspopup": "menu",
              "aria-expanded": view !== null && view.kind === "menu",
              disabled: pending,
              title: tooltipFor(state, flash),
              onClick: () => void launch(undefined),
              onContextMenu: (event) => {
                event.preventDefault();
                event.stopPropagation();
                setNotice(null);
                setView((current) => (current !== null && current.kind === "menu" ? null : { kind: "menu" }));
              },
            },
            pending
              ? h(SpinnerIcon)
              : flash !== null && flash !== undefined
                ? flash.ok
                  ? h(CheckIcon)
                  : h(CrossIcon)
                : h(PlayIcon),
          ),
          view !== null && view.kind === "menu"
            ? h(LaunchMenu, {
                state,
                notice,
                sessionId,
                onLaunch: launch,
                onSetDefault: setDefault,
                onClear: clearItems,
                onEdit: (item) => {
                  setNotice(null);
                  setView({ kind: "editor", mode: "edit", item });
                },
                onAdd: () => {
                  setNotice(null);
                  setView({ kind: "editor", mode: "add", item: null });
                },
                onClose: () => setView(null),
              })
            : null,
          view !== null && view.kind === "editor"
            ? h(ItemEditor, {
                sessionId,
                mode: view.mode,
                item: view.item,
                workspace: state === null ? null : state.workspace,
                onSaved: (payload, text) => {
                  setState(payload);
                  setNotice({ ok: true, text });
                  setView({ kind: "menu" });
                },
                onBack: () => setView({ kind: "menu" }),
                onClose: () => setView(null),
              })
            : null,
        );
      }

      /* ──────────────────────── the item list ──────────────────────── */

      function LaunchMenu(props) {
        const { state, notice, sessionId, onLaunch, onSetDefault, onEdit, onAdd, onClear, onClose } = props;

        react.useEffect(() => {
          const onKey = (event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          };
          window.addEventListener("keydown", onKey);
          return () => window.removeEventListener("keydown", onKey);
        }, [onClose]);

        const items = state !== null && Array.isArray(state.items) ? state.items : [];
        const workspacePath = state !== null && state.workspace !== null && state.workspace !== undefined
          ? state.workspace.path
          : null;

        const rows = items.map((item) =>
          h(
            "div",
            {
              key: `${item.scope}:${item.id}`,
              className: "dsh-lb-row",
              onContextMenu: (event) => {
                event.preventDefault();
                if (item.editable === true) onEdit(item);
              },
            },
            h(
              "button",
              {
                type: "button",
                className: "dsh-lb-row-main",
                title: `${item.path}\n左键：启动这项\n${KIND_LABEL[item.kind] ?? item.kind}`,
                onClick: () => onLaunch(item.id),
              },
              h("span", { className: "dsh-lb-row-icon" }, item.kind === "directory" ? h(FolderIcon) : h(PlayIcon)),
              h(
                "span",
                { className: "dsh-lb-row-text" },
                h(
                  "span",
                  { className: "dsh-lb-row-label" },
                  item.label,
                  item.isDefault === true ? h("span", { className: "dsh-lb-badge", key: "badge" }, "默认") : null,
                  item.exists === true ? null : h("span", { className: "dsh-lb-warn", key: "warn", title: "路径不存在" }, "⚠"),
                ),
                h("span", { className: "dsh-lb-row-path" }, item.path),
              ),
            ),
            h(
              "button",
              {
                type: "button",
                className: `dsh-lb-row-star${item.isDefault === true ? " is-on" : ""}`,
                title: item.isDefault === true ? "已经是默认启动项" : "设为默认（对话栏左键直接启动）",
                disabled: item.isDefault === true,
                onClick: () => onSetDefault(item),
              },
              h(StarIcon, { filled: item.isDefault === true }),
            ),
            item.editable === true
              ? h(
                  "button",
                  {
                    type: "button",
                    className: "dsh-lb-row-gear",
                    title: "设置这个启动项（名称 / 路径）",
                    onClick: () => onEdit(item),
                  },
                  h(GearIcon),
                )
              : null,
          ),
        );

        return h(
          react.Fragment,
          null,
          h("div", { className: "dsh-lb-scrim", onClick: onClose, key: "scrim" }),
          h(
            "div",
            { className: "dsh-lb-menu", role: "menu", key: "menu" },
            h(
              "div",
              { className: "dsh-lb-menu-head" },
              h("span", { className: "dsh-lb-menu-title" }, "启动项"),
              h("button", { type: "button", className: "dsh-lb-icon-btn", title: "关闭", onClick: onClose }, h(CrossIcon)),
            ),
            h(
              "div",
              { className: "dsh-lb-menu-sub" },
              workspacePath === null ? "这个对话没有关联的工作区目录" : `工作区：${workspacePath}`,
            ),
            notice !== null && notice !== undefined
              ? h("div", { className: `dsh-lb-note${notice.ok ? " is-ok" : " is-error"}` }, notice.text)
              : null,
            h(
              "div",
              { className: "dsh-lb-list" },
              rows.length > 0
                ? rows
                : h("div", { className: "dsh-lb-empty" }, state === null ? "加载中…" : "还没有启动项"),
            ),
            h(
              "div",
              { className: "dsh-lb-menu-foot" },
              h(
                "button",
                { type: "button", className: "dsh-lb-btn dsh-lb-btn-primary", onClick: onAdd },
                h("span", { className: "dsh-lb-btn-icon" }, h(PlusIcon)),
                "新建启动项",
              ),
              state !== null && state.sessionItemCount > 0
                ? h(
                    "button",
                    { type: "button", className: "dsh-lb-btn", onClick: onClear, title: "只清空这个对话自己新建的启动项" },
                    "清空本对话的启动项",
                  )
                : null,
            ),
            h(
              "div",
              { className: "dsh-lb-menu-hint" },
              sessionId === null ? "没有会话标识，无法绑定启动项" : "左键启动 · ★ 设为默认 · 右键或 ⚙ 单独设置",
            ),
          ),
        );
      }

      /* ─────────────────────── item settings ─────────────────────── */

      function parentOf(path) {
        if (typeof path !== "string") return "";
        const trimmed = path.trim().replace(/[\\/]+$/, "");
        const cut = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
        if (cut <= 0) return "";
        return trimmed.slice(0, cut);
      }

      function ItemEditor(props) {
        const { sessionId, mode, item, workspace, onSaved, onBack, onClose } = props;
        const editing = mode === "edit" && item !== null && item !== undefined;
        const [label, setLabel] = react.useState(editing ? (item.label ?? "") : "");
        const [value, setValue] = react.useState(editing ? item.path : workspace !== null && workspace !== undefined ? workspace.path : "");
        const [scope, setScope] = react.useState(editing && item.scope === "workspace" ? "workspace" : "session");
        const [browse, setBrowse] = react.useState(null);
        const [busy, setBusy] = react.useState(false);
        const [note, setNote] = react.useState(null);

        react.useEffect(() => {
          const onKey = (event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          };
          window.addEventListener("keydown", onKey);
          return () => window.removeEventListener("keydown", onKey);
        }, [onClose]);

        const loadBrowse = react.useCallback(
          async (target) => {
            setBusy(true);
            try {
              const payload = await getJson("browse", { sessionId, path: target ?? "" });
              setBrowse(payload);
            } catch (error) {
              setNote({ ok: false, text: messageOf(error) });
            } finally {
              setBusy(false);
            }
          },
          [sessionId],
        );

        const pickFolder = react.useCallback(async () => {
          const uiWorkspace = resolveUiWorkspace();
          if (uiWorkspace === undefined || typeof uiWorkspace.pickDirectory !== "function") {
            setNote({ ok: false, text: "这个界面没有提供目录选择器，请手动填写路径或点「浏览文件」" });
            return;
          }
          try {
            const picked = await uiWorkspace.pickDirectory();
            if (typeof picked === "string" && picked !== "") {
              setValue(picked);
              setNote(null);
            }
          } catch (error) {
            setNote({ ok: false, text: messageOf(error) });
          }
        }, []);

        const save = react.useCallback(async () => {
          setBusy(true);
          setNote(null);
          try {
            if (editing) {
              const payload = await postJson("item/update", {
                sessionId,
                scope: item.scope === "workspace" ? "workspace" : "session",
                id: item.id,
                label,
                path: value.trim(),
              });
              onSaved(payload, `已保存：${label.trim() === "" ? value.trim() : label.trim()}`);
            } else {
              const payload = await postJson("item/add", { sessionId, scope, label, path: value.trim() });
              const added = payload.added ?? {};
              onSaved(payload, `已添加启动项：${added.label ?? added.path ?? value.trim()}`);
            }
          } catch (error) {
            setNote({ ok: false, text: messageOf(error) });
          } finally {
            setBusy(false);
          }
        }, [editing, item, label, onSaved, scope, sessionId, value]);

        const remove = react.useCallback(async () => {
          setBusy(true);
          setNote(null);
          try {
            const payload = await postJson("item/remove", {
              sessionId,
              scope: item.scope === "workspace" ? "workspace" : "session",
              id: item.id,
            });
            onSaved(payload, `已删除：${item.label}`);
          } catch (error) {
            setNote({ ok: false, text: messageOf(error) });
          } finally {
            setBusy(false);
          }
        }, [item, onSaved, sessionId]);

        const browsePanel =
          browse === null
            ? null
            : h(
                "div",
                { className: "dsh-lb-browse" },
                h(
                  "div",
                  { className: "dsh-lb-browse-roots" },
                  (browse.roots ?? []).map((root) =>
                    h(
                      "button",
                      {
                        key: root.path,
                        type: "button",
                        className: "dsh-lb-chip",
                        title: root.path,
                        onClick: () => void loadBrowse(root.path),
                      },
                      root.label,
                    ),
                  ),
                  h(
                    "button",
                    { type: "button", className: "dsh-lb-chip", onClick: () => void loadBrowse(parentOf(browse.path ?? value)) },
                    "↑ 上级",
                  ),
                  h("button", { type: "button", className: "dsh-lb-chip", onClick: () => setBrowse(null) }, "收起"),
                ),
                h("div", { className: "dsh-lb-browse-path", title: browse.path ?? "" }, browse.path ?? "选择一个位置"),
                h(
                  "div",
                  { className: "dsh-lb-browse-list" },
                  (browse.entries ?? []).length === 0
                    ? h("div", { className: "dsh-lb-empty" }, "这里没有可启动的程序或子目录")
                    : (browse.entries ?? []).map((entry) =>
                        h(
                          "button",
                          {
                            key: entry.path,
                            type: "button",
                            className: "dsh-lb-browse-item",
                            title: entry.path,
                            onClick: () => {
                              if (entry.kind === "directory") {
                                void loadBrowse(entry.path);
                              } else {
                                setValue(entry.path);
                                setBrowse(null);
                              }
                            },
                          },
                          h("span", { className: "dsh-lb-row-icon" }, entry.kind === "directory" ? h(FolderIcon) : h(PlayIcon)),
                          h("span", { className: "dsh-lb-browse-name" }, entry.name),
                        ),
                      ),
                ),
              );

        return h(
          react.Fragment,
          null,
          h("div", { className: "dsh-lb-overlay", onClick: onClose, key: "overlay" }),
          h(
            "div",
            { className: "dsh-lb-panel", role: "dialog", "aria-modal": "true", key: "panel" },
            h(
              "div",
              { className: "dsh-lb-panel-head" },
              h("span", { className: "dsh-lb-panel-title" }, editing ? "设置启动项" : "新建启动项"),
              h("button", { type: "button", className: "dsh-lb-icon-btn", title: "关闭", onClick: onClose }, h(CrossIcon)),
            ),
            h(
              "div",
              { className: "dsh-lb-panel-sub" },
              editing ? `${KIND_LABEL[item.kind] ?? item.kind} · ${SCOPE_LABEL[item.scope] ?? item.scope}` : "一个启动项 = 一个程序或目录",
            ),
            h(
              "div",
              { className: "dsh-lb-field" },
              h("div", { className: "dsh-lb-field-label" }, "名称（可留空，默认用路径最后一段）"),
              h("input", {
                className: "dsh-lb-input",
                value: label,
                placeholder: "例如：我的项目",
                onChange: (event) => setLabel(event.target.value),
              }),
            ),
            h(
              "div",
              { className: "dsh-lb-field" },
              h("div", { className: "dsh-lb-field-label" }, "要启动的程序或目录（绝对路径）"),
              h("input", {
                className: "dsh-lb-input",
                value,
                placeholder: "例如：D:\\Games\\game.exe 或 C:\\Projects",
                onChange: (event) => setValue(event.target.value),
              }),
              h(
                "div",
                { className: "dsh-lb-actions" },
                h("button", { type: "button", className: "dsh-lb-btn", onClick: () => void pickFolder() }, "选择文件夹"),
                h("button", { type: "button", className: "dsh-lb-btn", onClick: () => void loadBrowse(value) }, "浏览文件"),
                workspace !== null && workspace !== undefined
                  ? h(
                      "button",
                      {
                        type: "button",
                        className: "dsh-lb-btn",
                        title: workspace.path,
                        onClick: () => {
                          setValue(workspace.path);
                          setNote(null);
                        },
                      },
                      "用工作区目录",
                    )
                  : null,
              ),
            ),
            !editing
              ? h(
                  "div",
                  { className: "dsh-lb-field" },
                  h("div", { className: "dsh-lb-field-label" }, "作用范围"),
                  h(
                    "label",
                    { className: "dsh-lb-radio" },
                    h("input", {
                      type: "radio",
                      name: "dsh-lb-scope",
                      checked: scope === "session",
                      onChange: () => setScope("session"),
                    }),
                    h("span", null, SCOPE_LABEL.session),
                  ),
                  h(
                    "label",
                    { className: `dsh-lb-radio${workspace === null || workspace === undefined ? " is-disabled" : ""}` },
                    h("input", {
                      type: "radio",
                      name: "dsh-lb-scope",
                      disabled: workspace === null || workspace === undefined,
                      checked: scope === "workspace",
                      onChange: () => setScope("workspace"),
                    }),
                    h("span", null, SCOPE_LABEL.workspace),
                  ),
                )
              : null,
            browsePanel,
            note !== null && note !== undefined
              ? h("div", { className: `dsh-lb-note${note.ok ? " is-ok" : " is-error"}` }, note.text)
              : null,
            h(
              "div",
              { className: "dsh-lb-panel-foot" },
              h(
                "button",
                { type: "button", className: "dsh-lb-btn dsh-lb-btn-primary", disabled: busy, onClick: () => void save() },
                busy ? "处理中…" : "保存",
              ),
              editing
                ? h("button", { type: "button", className: "dsh-lb-btn dsh-lb-btn-danger", disabled: busy, onClick: () => void remove() }, "删除")
                : null,
              h("button", { type: "button", className: "dsh-lb-btn", onClick: onBack }, "返回列表"),
            ),
            h(
              "div",
              { className: "dsh-lb-menu-hint" },
              "保存后回到列表即可看到；★ 把它设为默认，对话栏左键就会直接启动它。",
            ),
          ),
        );
      }

      /* ─────────────────────────── styles ─────────────────────────── */

      const STYLES = `
.dsh-lb-button{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer;transition:background .15s ease,color .15s ease}
.dsh-lb-button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.16));color:var(--dsw-alias-label-primary,#111827)}
.dsh-lb-button:disabled{cursor:default;opacity:.75}
.dsh-lb-button[data-state="ok"]{color:#3fb950}
.dsh-lb-button[data-state="error"]{color:var(--dsw-alias-state-error-primary,#f85149)}
.dsh-lb-button[data-state="stale"]{color:#d29922}
.dsh-lb-spin{animation:dsh-lb-rotate .8s linear infinite}
@keyframes dsh-lb-rotate{to{transform:rotate(360deg)}}
.dsh-lb-scrim{position:fixed;inset:0;z-index:2147482999;background:transparent}
.dsh-lb-menu{position:fixed;right:16px;bottom:78px;z-index:2147483000;width:min(380px,calc(100vw - 32px));max-height:min(60vh,520px);display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));border-radius:12px;background:var(--dsh-lb-surface,#fff);color:var(--dsw-alias-label-primary,#111827);box-shadow:0 18px 48px rgba(0,0,0,.28);font:13px/1.5 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.dsh-lb-menu-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px 6px}
.dsh-lb-menu-title{font-weight:600;font-size:13.5px}
.dsh-lb-menu-sub{padding:0 12px 8px;color:var(--dsw-alias-label-secondary,#6b7280);font-size:11.5px;word-break:break-all}
.dsh-lb-list{flex:1 1 auto;overflow:auto;padding:0 6px 6px}
.dsh-lb-row{display:flex;align-items:center;gap:2px;border-radius:9px;padding:2px}
.dsh-lb-row:hover{background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.12))}
.dsh-lb-row-main{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:8px;padding:7px 6px;border:0;border-radius:8px;background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit}
.dsh-lb-row-icon{flex:none;display:inline-flex;color:var(--dsw-alias-label-secondary,#6b7280)}
.dsh-lb-row-text{min-width:0;display:flex;flex-direction:column}
.dsh-lb-row-label{display:flex;align-items:center;gap:6px;font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-lb-row-path{color:var(--dsw-alias-label-secondary,#6b7280);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-lb-badge{flex:none;padding:1px 6px;border-radius:6px;background:var(--dsw-alias-brand-primary,#3b82f6);color:#fff;font-size:10px;font-weight:600}
.dsh-lb-warn{color:#d29922;font-size:12px}
.dsh-lb-row-star,.dsh-lb-row-gear{flex:none;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#9ca3af);cursor:pointer}
.dsh-lb-row-star:hover:not(:disabled),.dsh-lb-row-gear:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.18));color:var(--dsw-alias-label-primary,#111827)}
.dsh-lb-row-star.is-on{color:#e3b341;cursor:default}
.dsh-lb-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer}
.dsh-lb-icon-btn:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.18));color:var(--dsw-alias-label-primary,#111827)}
.dsh-lb-menu-foot{display:flex;flex-wrap:wrap;gap:6px;padding:8px 10px;border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22))}
.dsh-lb-menu-hint{padding:0 12px 10px;color:var(--dsw-alias-label-secondary,#6b7280);font-size:11px}
.dsh-lb-btn{display:inline-flex;align-items:center;gap:5px;padding:5px 10px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));border-radius:8px;background:transparent;color:inherit;cursor:pointer;font:inherit;font-size:12px}
.dsh-lb-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.16))}
.dsh-lb-btn:disabled{opacity:.55;cursor:default}
.dsh-lb-btn-primary{border-color:transparent;background:var(--dsw-alias-brand-primary,#3b82f6);color:#fff}
.dsh-lb-btn-primary:hover:not(:disabled){filter:brightness(1.08)}
.dsh-lb-btn-danger{border-color:transparent;background:transparent;color:var(--dsw-alias-state-error-primary,#f85149)}
.dsh-lb-btn-danger:hover:not(:disabled){background:rgba(248,81,73,.14)}
.dsh-lb-btn-icon{display:inline-flex}
.dsh-lb-overlay{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.32)}
.dsh-lb-panel{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:2147483001;width:min(440px,calc(100vw - 40px));max-height:min(86vh,720px);overflow:auto;padding:14px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));border-radius:14px;background:var(--dsh-lb-surface,#fff);color:var(--dsw-alias-label-primary,#111827);box-shadow:0 24px 64px rgba(0,0,0,.34);font:13px/1.55 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.dsh-lb-panel-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dsh-lb-panel-title{font-weight:600;font-size:14px}
.dsh-lb-panel-sub{padding:2px 0 10px;color:var(--dsw-alias-label-secondary,#6b7280);font-size:11.5px}
.dsh-lb-field{display:flex;flex-direction:column;gap:5px;margin-bottom:12px}
.dsh-lb-field-label{color:var(--dsw-alias-label-secondary,#6b7280);font-size:11.5px}
.dsh-lb-input{width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));color:inherit;font:inherit;font-size:12.5px}
.dsh-lb-input:focus{outline:2px solid var(--dsw-alias-brand-primary,#3b82f6);outline-offset:-1px}
.dsh-lb-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:2px}
.dsh-lb-radio{display:flex;align-items:center;gap:7px;padding:4px 0;cursor:pointer}
.dsh-lb-radio.is-disabled{opacity:.5;cursor:default}
.dsh-lb-note{margin:0 0 10px;padding:7px 9px;border-radius:8px;font-size:12px}
.dsh-lb-note.is-ok{background:rgba(63,185,80,.14);color:#2ea043}
.dsh-lb-note.is-error{background:rgba(248,81,73,.14);color:var(--dsw-alias-state-error-primary,#f85149)}
.dsh-lb-browse{margin:0 0 12px;padding:8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));border-radius:10px}
.dsh-lb-browse-roots{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:7px}
.dsh-lb-chip{padding:3px 8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:999px;background:transparent;color:inherit;cursor:pointer;font:inherit;font-size:11.5px}
.dsh-lb-chip:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.16))}
.dsh-lb-browse-path{margin-bottom:6px;color:var(--dsw-alias-label-secondary,#6b7280);font-size:11px;word-break:break-all}
.dsh-lb-browse-list{max-height:190px;overflow:auto;display:flex;flex-direction:column}
.dsh-lb-browse-item{display:flex;align-items:center;gap:7px;padding:5px 6px;border:0;border-radius:7px;background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit;font-size:12px}
.dsh-lb-browse-item:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.16))}
.dsh-lb-browse-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-lb-empty{padding:8px 6px;color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px}
.dsh-lb-panel-foot{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
body[data-ds-dark-theme] .dsh-lb-menu,body[data-ds-dark-theme] .dsh-lb-panel{--dsh-lb-surface:#1f2430}
@media (prefers-color-scheme:dark){.dsh-lb-menu,.dsh-lb-panel{--dsh-lb-surface:#1f2430}}
`.trim();

      function mountStyles() {
        const style = document.createElement("style");
        style.dataset.dshLaunchButtons = "";
        style.textContent = STYLES;
        document.head.append(style);
        return () => {
          style.remove();
        };
      }

      function apply(ctx) {
        clientCtx = ctx;
        ctx.effect(() => mountStyles(), "dsh-launch-buttons: styles");
        ctx.effect(
          () =>
            ctx.slots.inject("conversation.input.right", () =>
              ctx.slots.register(
                {
                  name: "conversation.input.right",
                  id: "dsh-launch-buttons",
                  order: 20,
                  label: () => "启动项",
                },
                LaunchButton,
              ),
            ),
          "dsh-launch-buttons: composer button",
        );
      }

      exports.apply = apply;
      exports.inject = inject;
      exports.LaunchButton = LaunchButton;
      exports.LaunchMenu = LaunchMenu;
      exports.ItemEditor = ItemEditor;
      exports.resolveUiWorkspace = resolveUiWorkspace;
      exports._setClientCtx = (value) => {
        clientCtx = value;
      };
      return module.exports;
    },
  });
}
