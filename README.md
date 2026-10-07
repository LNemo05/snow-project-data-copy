# 项目数据复制 · Project Data Copier

一个 **Snow App** 面板插件：把**项目记忆**与**备忘录**从一个项目复制到另一个项目 —— 支持本机 ↔ SSH 互传 —— 且**源项目全程只读**。

## 功能

- **任意两个项目之间复制**，本机与 SSH 项目均可，也能本机 → SSH
- **逐条勾选 + 自动去重**：内容已存在于目标的条目会标记「已存在」并默认跳过
- **两步确认**才写入（刻意不用 `window.confirm` —— 它在 Electron 宿主里会弹原生对话框，行为不可控）
- **一键撤销**：只删除插件本次刚创建的条目，绝不碰其他数据
- **复制后自动复核**，并在可展开的日志里给出逐条结果

## 字段保真

| 数据类型 | 原样复制 | 由系统重新生成 |
|---|---|---|
| 项目记忆 | `kind`、`title`、`content`、`importance`、`tags` | `source`、`conversationId`、`createdAt`、`updatedAt`、`memoryId` |
| 备忘录 | `content`（含 HTML 富文本）、`status` | `createdAt`、`updatedAt`、`memoId` |

官方写入 API **设计上就不接受 `createdAt` / `updatedAt`**（`memory.update` 文档给出的可更新字段列表是 `title / content / kind / importance / status / tags`），因此原始时间戳无法通过 API 保留，会在复制时重设为当前时间。

> 备忘录正文可能包含 HTML。插件按字节原样搬运，仅在界面展示时剥离标签以避免渲染风险。

## 权限声明

| Scope | 用途 |
|---|---|
| `memory` | 读取项目记忆，并在目标项目中创建 |
| `memos` | 读取备忘录，并在目标项目中创建 |

项目列表来自无需声明的 `projects` 元数据域。

**源项目是只读的**：插件从不对它发起 `update` 或 `remove`。`remove` 只作用于插件本次自己创建的条目，且只能通过「撤销」按钮触发。

## 安装

- 从**插件市场**一键安装，或
- **插件列表 → 面板插件 → 从文件夹安装**，选择本目录（含 `plugin.json` 的那一层）

## 打包注意

发布用的 zip 必须让 `plugin.json` 位于**根目录**，不要多套一层文件夹：

```powershell
Compress-Archive -Path .\plugin.json,.\index.js,.\style.css -DestinationPath ..\com.wu.memcopy-<version>.zip -Force
Get-FileHash ..\com.wu.memcopy-<version>.zip -Algorithm SHA256
```

## License

MIT

---

# English

A **Snow App** panel plugin that copies **project memories** and **memos** between projects — including **local ↔ SSH** — while leaving the source project **completely untouched**.

**Features**: per-item selection with duplicate detection; two-step confirmation before writing (deliberately avoiding `window.confirm`, which misbehaves in the Electron host); one-click undo that removes only the entries this plugin just created; automatic post-copy verification with a detailed log.

**Field fidelity**: `kind / title / content / importance / tags` are copied verbatim for memories, and `content` (including HTML) plus `status` for memos. The official write API ignores `createdAt` / `updatedAt` by design, so original timestamps are regenerated at copy time.

**Privacy scopes**: `memory` and `memos`. The project list comes from the declaration-free `projects` domain. **The source project is read-only** — no `update` or `remove` is ever issued against it.

**Install**: from the plugin market, or via *Plugin list → Panel plugins → Install from folder*.
