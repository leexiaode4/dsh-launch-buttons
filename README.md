# dsh-launch-buttons

Multiple launch buttons for the DSH composer. A standalone copy of `dsh-launch-button` —
the original plugin is left untouched ([中文说明见下方](#中文)).

- **Left-click** the main button → launches the *default* item. With nothing configured yet,
  the default is the current conversation's workspace directory.
- **Right-click** the main button → opens the **launch-item list** (one row per item).
- Each row in that list: click the row to launch its bound program or directory, `★` makes it
  the default, `⚙` (or right-clicking the row) opens that item's own settings — label, path,
  delete.
- `＋ New launch item` at the bottom: give it a label and an absolute path, scoped to
  *this conversation only* or to *the whole workspace*.

State lives on the host in `$DSH_HOME/launch-buttons/store.json`, so it survives page
reloads and is shared by every client of the same profile.

### Install

```sh
dsh plugin --profile desktop add github:leexiaode4/dsh-launch-buttons   # from GitHub
dsh plugin --profile desktop add "<path to this checkout>"              # from a local copy
dsh plugin --profile desktop add dsh-launch-buttons                     # from npm, once published
```

Then restart DSH completely — the wiring is host-side, a page refresh is not enough. If
`dsh-launch-button` is also installed, disable it in the profile patch so the composer does
not show two launcher buttons:

```yaml
- id: dsh-launch-button
  disabled: true
```

### Compatibility

- Any DSH speaking the `dsh.bundle` protocol (`>= 0.1.5-rc.1`); no build step, no runtime
  dependency beyond Node itself. `react` is an optional peer.
- Windows, macOS and Linux: folders and documents are opened with `explorer.exe`, `open` and
  `xdg-open` respectively; executables are spawned directly.
- The client half renders in the Web platform (browser and Electron-based desktop clients).

### Tests

```sh
node --test test/core.test.mjs test/host.integration.test.mjs test/client.test.mjs
```

Every launch case in the suite is a refusal path — the tests never start a real process.

BSD-3-Clause.

---

## 中文

对话输入框右下角的多启动项按钮。它是 `dsh-launch-button` 的**独立副本**，原插件一行未改。

- **左键**主按钮 → 启动“默认启动项”。还没有配置任何启动项时，默认就是**当前对话的工作区目录**。
- **右键**主按钮 → 弹出**启动项列表**（每一行是一个启动项）。
- 列表里**每一行**：
  - 点行本身 → 启动它绑定的程序或目录；
  - `★` → 把它设为默认（此后左键主按钮直接启动它）；
  - `⚙`（或在该行上右键）→ 打开**它自己的设置**：名称、路径、删除。
- 列表底部 `＋ 新建启动项`：填写名称与绝对路径，可选“只绑定这个对话”或“绑定整个工作区”。

## 数据放在哪

`$DSH_HOME/launch-buttons/store.json`：

```json
{
  "version": 2,
  "sessions":   { "<会话 id>":   { "items": [ { "id": "…", "label": "…", "path": "…", "at": "…" } ], "defaultId": "…" } },
  "workspaces": { "<工作区键>": { "items": [ … ], "defaultId": "…" } }
}
```

- 启动项分两个作用域：**这个对话**（`sessions`）与**这个工作区**（`workspaces`，该目录下的所有对话共享）。
- 列表顺序：本对话的启动项 → 本工作区的启动项 → 内置的「工作区」行（兜底）。
- 默认值解析：本对话的 `defaultId` → 本工作区的 `defaultId` → 内置工作区目录。默认项被删掉时自动回退到第一条。
- `defaultId` 可以是 `"workspace"`，表示“默认就是工作区目录本身”。
- 一个作用域最多 24 个启动项。

**从旧插件继承**：第一次读取时，如果本插件自己的 `store.json` 还不存在，而旧的
`$DSH_HOME/launch-button/bindings.json` 存在，就把它导入（旧文件保持原样，不删）。所以换过来之后行为与原来一致，直到你配置了新东西。

## 安装

与 `dsh-launch-button` 相同的接法。**推荐直接用一条命令**（会自动写下面第 1、2 步）：

```sh
dsh plugin --profile desktop add "C:\path\to\dsh-launch-buttons"
# 或直接从 GitHub 装：
dsh plugin --profile desktop add github:leexiaode4/dsh-launch-buttons
```

手动接线的两步：

1. 在目标 profile 的 `node_modules` 里建一个指向本目录的链接（Windows：目录 junction；macOS/Linux：`ln -s`）：
   `<profile>/node_modules/dsh-launch-buttons` → `<本目录>`
2. profile 的 `package.json`：
   - `dependencies` 加 `"dsh-launch-buttons": "link:<本目录>"`
   - `dsh.profile.bundles` 数组里加 `"dsh-launch-buttons"`
3. 想让新的按钮**替代**原来的按钮时，在 profile 的 `cordis.patch.yml` 里把原插件关掉：

   ```yaml
   - id: dsh-launch-button
     disabled: true
   ```

   不关掉的话输入框右侧会同时出现两个启动按钮（一个旧的、一个新的），两个都能用。
4. **完全退出并重开** DSH（改的是 Host 侧接线，刷新页面不够）。

也可以走桌面端的插件管理器界面（可能需要一次批准）：

```
npx --yes @deepseek-ai/dsh@<你运行中的版本> plugin --profile desktop add "<本目录或包名>"
```

## 验证

- 打开 `http://127.0.0.1:<DSH 的端口>/dsh-launch-buttons/health`：应返回
  `{"ok":true,"plugin":"dsh-launch-buttons","strategy":"multi-item",…}`（带 `storePath`）。
- 输入框右侧出现 ▶ 按钮：左键应能打开工作区目录；右键应弹出启动项列表。
- 加一个启动项 → 在列表里点它应能启动；点 `★` 后左键主按钮应直接启动它。
- 失败时看桌面端日志里的 `web boot: N entry did not activate`，把原文发出来即可定位。

## 回退

删掉 profile `package.json` 里的 `dsh-launch-buttons`（dependencies + bundles 各一行）与那个
node_modules 链接、重启即可；`$DSH_HOME/launch-buttons/` 可以直接删（旧插件的
`$DSH_HOME/launch-button/` 从未被改动）。关掉原插件的 `disabled: true` 那两行删掉即可恢复旧按钮。

## 边界

- 只能启动**程序或目录**（`.exe/.com/.scr` 直接启动；目录、文档、脚本交给平台 opener 用系统默认程序打开，与双击等价：Windows `explorer.exe`、macOS `open`、Linux `xdg-open`；POSIX 上带可执行位的文件直接启动）。
  刻意**不走 `cmd /c start`**：cmd 会二次解析参数，路径里带 `& | ^ < > % !` 就会执行第二条命令，而从 Node 这边没法给 cmd 传一个安全引号化的路径（libuv 只给含空格或引号的参数加引号）。
- 路径必须是**绝对路径且当前存在**，添加时会检查。
- Host 启动子进程时刻意**不传 `windowsHide` / `detached`**：本机 `windowsHide: true` 会变成
  `CREATE_NO_WINDOW`，子进程会在加载器里以 `0xC0000142`（`STATUS_DLL_INIT_FAILED`）当场死掉——
  看起来“启动成功”其实什么都没打开。
- 状态只存在 Host 侧，客户端不做 localStorage；换界面/刷新不会丢。
- 打开文件夹/文档通过系统 opener（Windows `explorer.exe`），因此以管理员身份运行的 DSH 与以普通身份运行的 DSH 打开的窗口权限不同。

## 测试

```
node --test test/core.test.mjs test/host.integration.test.mjs test/client.test.mjs
```

`core.test.mjs` 覆盖纯逻辑（路径判定、启动计划、store 归并与迁移、默认值解析、回环判定）；
`host.integration.test.mjs` 用假 ctx + 真 http server 驱动整套 JSON API（**所有启动用例都是拒绝路径，不会真的启动进程**）；
`client.test.mjs` 校验模块 id、`slots` 注入、座位与注入的 CSS。

## 文件

| 文件 | 作用 |
| --- | --- |
| `lib/core.js` | 纯逻辑：启动计划、store 形状与迁移、默认项解析、loopback 判定 |
| `lib/index.js` | Host：`/dsh-launch-buttons` JSON API、读写 store、启动进程 |
| `lib/client.js` | 客户端：输入框按钮、启动项列表、单项设置面板 |
| `cordis.patch.yml` | bundle 补丁，把 `dsh-launch-buttons` 插进 cordis |
