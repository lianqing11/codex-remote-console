# Coding Agent Console

**在浏览器中使用 Codex、Cursor Agent 和 Claude Code 的自托管工作台。**

[English](README.md) · 简体中文

把代码仓库、编程 Agent 和开发环境保留在工作站或远程服务器上，通过电脑或手机浏览器提交任务、查看实时输出、处理 Codex 审批、浏览文件和检查代码改动。任务进入服务端队列后，只要服务器和 Agent 进程继续运行，关闭网页也能继续执行。

![工作台流程概览](docs/images/console-overview.svg)

[快速开始](#快速开始) · [功能](#功能) · [模型与工具支持](#模型与工具支持) · [部署](#部署) · [配置](#配置) · [常见问题](#常见问题)

## 功能

| 使用场景 | 工作台提供的能力 |
| --- | --- |
| 使用不同编程助手 | 支持 Codex、Cursor Agent、Claude Code，各自保留独立会话与控制选项。 |
| 连续安排任务 | 每个会话拥有 SQLite 持久化队列，显示执行、等待和暂停状态，可恢复、重试或移除任务。 |
| 跟进长任务 | 流式 Markdown、工具执行记录、以用户问题为标题的可折叠对话，以及可用时显示的请求耗时。 |
| 回到之前的工作 | 最近会话、浏览器前进/后退、会话链接、当前标签页的文字草稿恢复，以及分批加载历史。 |
| 检查项目内容 | 目录浏览、Markdown 预览与源码、带行号的代码查看、项目文件上传、单轮和工作区 Git Diff。 |
| 补充任务上下文 | 每轮最多 8 个附件，支持选择、粘贴和拖放；图片作为视觉输入传给 Agent。 |
| 调整显示方式 | 浅色、深色、跟随系统主题，绿/蓝/紫/琥珀强调色，手机简洁与详细布局。 |
| 查看用量 | 在账号提供数据时显示 Codex 额度和 Cursor 套餐内剩余额度。 |
| 接收可选通知 | 飞书会话群接收最终回复和 Codex Plan 模式下的输入请求提醒。 |

### 最近更新

- **对话响应优化**：首段文字立即展示，持续输出按短间隔刷新，各供应商会话列表独立加载，减少重复历史和队列请求。
- **会话恢复改进**：为 Codex 历史读取设置等待边界，修正最近会话排序，增加连接心跳和重连处理，按供应商与会话分别保存草稿。
- **任务展示改进**：完善 Claude 工具记录显示，展开的对话使用用户问题作为标题，增加正文可用空间，修正顶部用量标签尺寸。
- **长会话管理**：设置一致时复用 Codex 常驻线程，支持自动压缩阈值、手动压缩，以及可编辑的交接内容，便于开启新会话。
- **主题与手机体验**：保存外观偏好，手机提供“会话 / 聊天 / 工具”导航和键盘感知布局。原生 iPhone 键盘行为仍需真机验证。

当前文件工作区支持浏览、预览、上传和 Diff，尚未包含内嵌 VS Code/code-server 编辑器。

## 分叉会话

在会话菜单或顶栏（手机上在 Tools 面板里）点击 **Fork session**，也可以输入 `/fork`。新会话继承上下文和运行设置，创建后切换到分支，等待你主动发送消息。Codex 和 Claude 的每个已完成轮次标题上都有 **Fork**，分支保留该轮及之前的历史。

分支与原会话共享项目文件，后续消息、草稿和任务队列独立。每个分支都是普通的独立会话，按创建时间进入 Recent 排序，不显示来源标签或层级。源会话存在执行中、等待输入或排队任务时，需要先完成这些任务再分叉。

Cursor 原生存储适配仅支持 CLI **2026.09.28-64d2043**。未知版本会禁用入口，存储结构不兼容或损坏会明确报错。Claude 仅在复制原生历史时使用锁定版本的 Agent SDK（按轮次分叉时截到所选轮次为止），续聊沿用 Claude CLI。分叉操作本身不会发送模型请求。

父子关系与幂等记录保存在 `.codex_web/forks.sqlite`，可用 `CODEX_WEB_FORK_STATE_DIR` 指定运行目录。迁移或备份时，请同时保留该目录和各供应商的原生会话。断线或重启后重试已完成请求会返回同一分支；如果供应商失败且无法确定是否已生成原生会话，会保留未完成记录供检查，防止重复创建。

## 模型与工具支持

请使用**运行工作台的同一个系统用户**安装并登录所需 CLI。各供应商独立检测状态，某个 CLI 缺失或未登录不会禁用其他供应商。

| 能力 | Codex | Cursor Agent | Claude Code |
| --- | --- | --- | --- |
| 本地命令 | `codex` | `cursor-agent` | `claude` |
| 后端方式 | `codex app-server` | 原生 CLI 会话与流式 JSON | CLI 会话 ID、恢复会话与流式 JSON |
| 执行模式 | Agent / Plan | Agent / Plan / Ask | Agent / Plan |
| 运行选项 | 模型、思考强度、沙箱、审批、服务等级 | 模型和执行模式 | 对应供应商的模型与模式选项 |
| 网页审批与输入请求 | 支持 | 暂未开放 | 暂未开放 |
| 从会话末尾分叉 | 支持 | 按版本适配原生存储 | 支持 |
| 从已完成轮次分叉 | 支持 | 不支持 | 支持 |
| 切换模式 | 修改会话运行设置 | 创建新的空白 Cursor 会话 | 保留同一个会话 |

切换**供应商**会在相同工作目录创建空白会话，不会迁移上下文。

Cursor Agent 使用 `--sandbox disabled --trust`，拥有 Node 服务用户的文件系统访问权限；Cursor Plan 和 Ask 为只读模式。Claude Agent 使用 `acceptEdits`，Plan 使用 `plan`。界面会隐藏不支持的选项。

## 快速开始

准备 **Node.js 24**（已使用 24.12.0 验证）、npm、Git，以及至少一个已登录的供应商 CLI。服务端依赖内置 `node:sqlite` 和 `process.loadEnvFile`，当前实现不支持 Node 18。

```bash
git clone https://github.com/lianqing11/codex-remote-console.git
cd codex-remote-console
npm ci
cp .env.example .env.local
```

启动前编辑 `.env.local`：

```dotenv
HOST=127.0.0.1
PORT=3032
CODEX_WEB_PASSWORD=replace-with-a-strong-password
CODEX_WEB_SECRET=replace-with-a-long-random-secret
```

将密码和签名密钥替换为自己的随机值，然后启动：

```bash
npm run dev
```

打开 **http://127.0.0.1:3032**，登录后选择项目目录和供应商，即可发送任务。访问远程服务器时使用私有隧道或下方的反向代理方式。服务会自动加载 `.env.local`，已有进程环境变量优先。

> 本项目处于 Alpha 阶段，适合可信的私有部署。Agent 以 Node 服务用户权限执行命令。请配置认证，并使用 TLS 或私有隧道；凭据不要提交到 Git。项目根目录限制作用于文件 API，不构成 Agent 沙箱或多租户安全隔离。

## 部署

### 生产运行

在 `.env.local` 中配置好认证后执行：

```bash
npm run build
npm run start
```

生产环境要求设置 `CODEX_WEB_PASSWORD` 或 `CODEX_WEB_TOKEN`。使用独立随机的 `CODEX_WEB_SECRET` 签名 Cookie。通过 HTTPS 访问时设置 `CODEX_WEB_COOKIE_SECURE=on`。

### 反向代理与子路径

构建和启动时使用相同的路径前缀：

```bash
NEXT_PUBLIC_BASE_PATH=/codex_web_cursor npm run build
NEXT_PUBLIC_BASE_PATH=/codex_web_cursor npm run start
```

将 `https://your-host.example/codex_web_cursor/` 转发到本机回环监听地址，支持 WebSocket 升级，并在转发到上游时移除 `/codex_web_cursor` 前缀。自定义 HTTP/WebSocket 服务使用根路径，Next.js 静态资源使用配置的子路径。

内置 `dev:proxy`、`build:proxy`、`start:proxy` 脚本使用 `/codex_web_cursor` 和 3032 端口。`start:proxy` 会先重新构建。重启已有服务前，请等待正在执行的工作和队列空闲。

## 配置

完整模板见 [`.env.example`](.env.example)。真实密码、路径和代理地址应放在 `.env.local` 或进程管理器环境中。

| 环境变量 | 用途 |
| --- | --- |
| `HOST`、`PORT` | 监听地址与端口，建议显式设置；代码默认 `0.0.0.0:3000`，示例配置使用 3032。 |
| `CODEX_WEB_PASSWORD` / `CODEX_WEB_TOKEN` | 工作台登录凭据。 |
| `CODEX_WEB_SECRET` | Cookie 签名密钥。 |
| `NEXT_PUBLIC_BASE_PATH` | 反向代理子路径，构建和运行时必须一致。 |
| `CODEX_WEB_PROJECT_ROOTS` | 限制项目解析、目录列表和读取 API 的可访问根目录。 |
| `CODING_AGENT_CONSOLE_STATE_DIR` | 工作台状态目录，默认 `~/.local/share/coding-agent-console`。 |
| `CODEX_WEB_UPLOAD_MAX_BYTES` | 单文件上传限制，默认 50 MiB，上限 100 MiB。 |
| `CODEX_WEB_AUTO_COMPACT_TOKEN_LIMIT` | 托管 Codex stdio 的自动压缩阈值，默认 `200000`；可设为 ≥ `10000` 的整数或 `inherit`。 |
| `CODEX_WEB_PROXY_URL` | 为 Agent 提供本地选择性代理的上游地址；OpenAI/Cursor/Anthropic 官方域名走代理，其他流量直连。 |
| `CODEX_WEB_FEISHU_NOTIFY` | 设为 `on` 开启可选飞书通知。 |

### 附件与项目上传

**Attach to agent** 将任务附件上传到私有状态目录。移除尚未发送的附件时会删除服务端副本。文字草稿通过 `sessionStorage` 在当前标签页刷新后恢复，附件不会作为草稿恢复。

**Files → Upload here** 将文件直接写入当前项目目录，不依赖某次对话而存在。覆盖已有文件需要确认。

### 队列与长会话

已接收的文字请求在调度前写入 SQLite。失败、停止、审批或重启后的不确定状态可能暂停队列，等待检查。关闭浏览器不取消服务端任务，停止服务器可能中断任务。

Codex 仅在恢复设置一致时复用常驻线程；修改模型、权限等设置会重新恢复会话。托管 stdio 的压缩设置在服务空闲重启后生效，外部 WebSocket 网关使用自己的配置。压缩可能丢失较早的细节，也会耗时；独立任务可使用可编辑的交接内容开启新会话。

队列请求会在可用时保存接收、调度、恢复、启动、首段输出/工具调用和结束时间。旧请求或未经过队列的请求可能缺少这些字段。累计 Token 用量与最近一次请求输入分开显示。

### 可选飞书通知

设置 `CODEX_WEB_FEISHU_NOTIFY=on`，私下配置 `CODEX_WEB_FEISHU_USER_OPEN_ID`，并完成 `lark-cli` 机器人登录。每个供应商会话对应一个私有群，接收任务结束通知。较长的最终回复按顺序拆分发送，分段大小由 `CODEX_WEB_FEISHU_CHUNK_MAX_BYTES` 控制。

Codex Plan 的输入请求也会发送选项提醒，答案需要返回网页提交；通知为单向提醒。其他审批请求不会触发该提醒。Cursor 失败或取消的任务也会发送结束通知。

## 开发与验证

```bash
npm run typecheck
npm run test:all
npm run build
```

`npm run check` 组合类型检查和构建，`npm run check:proxy` 使用内置子路径构建。如果运行中的服务使用默认构建目录，请通过 `NEXT_DIST_DIR=.next-review` 使用独立输出目录。

浏览器检查需要 Python、Playwright、Chromium 和已运行的测试前端。例如 `npm run test:playwright-appearance` 使用模拟供应商事件验证主题、手机布局、流式展示、重连和认证过期。配置 `CODING_AGENT_CONSOLE_TEST_URL` 与正常认证环境后运行，报告保存在已忽略的 `.codex_web/ui-verification/`。模拟测试不能证明真实供应商执行或原生 iPhone 行为。

自定义服务入口为 [`server/index.ts`](server/index.ts)，供应商适配器位于 [`server/providers`](server/providers)，Codex 网关位于 [`server/codex`](server/codex)。HTTP/WebSocket 路由见 [API 文档](docs/API.md)，专项测试命令见 [`package.json`](package.json)。

## 常见问题

| 问题 | 检查方法 |
| --- | --- |
| 缺少 `node:sqlite` 或 `loadEnvFile` | 确认服务进程使用 Node 24；仅切换交互终端版本可能不够。 |
| 某个供应商不可用 | 用服务用户检查 CLI 和登录状态；Claude 可运行 `claude auth status`，Cursor 可运行 `cursor-agent --list-models`。 |
| 生产模式拒绝启动 | 配置 `CODEX_WEB_PASSWORD` 或 `CODEX_WEB_TOKEN`。 |
| Codex app-server 启动超时 | 在相同环境运行 `codex app-server`，检查 `[codex-app-server]` 日志。 |
| Agent 连接错误 | 检查供应商网络与可选代理配置，在服务空闲时重启以应用环境变量变更。 |
| 反向代理后资源或 WebSocket 异常 | 检查构建/运行子路径一致、上游前缀剥离、WebSocket 升级转发。 |
| 失败或重启后队列暂停 | 检查前一个操作是否已完成，再使用 Resume/Retry。 |
| 重启后 Cursor 记录缺失 | 检查状态目录权限、磁盘空间，以及服务用户或状态路径是否发生变化。 |

## 参与贡献与许可证

欢迎提交 Issue 和范围明确的 PR，请附复现步骤与相关验证。不要提交凭据、运行状态、上传文件、日志或构建产物。

本项目使用 [MIT 许可证](LICENSE)。
