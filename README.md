# AIWorkerControlDesk

AIWorkerControlDesk 是一个本地 AI Worker 调度台，用来在多个本地项目中启动、观察、接管和续工真实的 CLI Worker Session。

它的重点不是把 Claude Code 包成普通聊天窗口，而是让你看清楚：哪个项目正在跑 Worker、哪个 Session 正在等待或失败、当前输出是否需要接管、以及结束后能否基于 Summary 新开一个真实 Session 继续。

## 核心能力

- 多 Project：为不同本地项目维护独立工作空间。
- 多 Session：观察 Claude Code / GenericAgent Session 的运行、等待、失败和退出状态。
- Provider Catalog：在本地配置 Provider、模型和 Worker 可用性。
- Claude Code 主路径：使用真实 Claude Code 原生 PTY 进程，并只读投影原生 jsonl 输出。
- GenericAgent：可作为 Claude Code 之外的轻量执行 Worker。
- 原生接管：需要 TUI、权限确认或 slash 管理命令时，可临时接管同一个 Session 的原生 PTY。
- Summary 续工：Session 结束后，可基于 Summary 新建真实 Session 继续。
- Windows 打包：支持生成可双击安装的 Windows 安装包。

## 它不是什么

AIWorkerControlDesk 不是普通聊天 UI、IDE、文件管理器、Git 工作台、MCP 管理器、任务 DAG、workflow 平台或通用 Agent 编排平台。

当前版本只围绕本地 Project、Provider、Worker、Session、Radar、右栏 AI 输入输出页、原生 PTY 接管和 Summary 续工收口。

## 环境要求

- Node.js 与 npm
- Windows 11（当前打包目标为 Windows x64）
- 本机可用的 Claude Code
- 可用于 Claude Code 或 GenericAgent 的 Provider / Model 配置

## 本地开发运行

```bash
npm install
npm run dev
```

## 生产构建运行

```bash
npm run build
npx electron .
```

## 生成 Windows 安装包

```bash
npm run pack:win
```

生成后主要产物在 `dist/`：

- `dist/*.exe`：Windows NSIS 安装器。
- `dist/win-unpacked/AIWorkerControlDesk.exe`：免安装版本，适合快速验收打包后的应用。

`dist/` 是构建产物，不建议提交到仓库；发布安装包时应作为 Release 附件上传。

## 验证命令

```bash
npm run lint
npm run typecheck
npm run test
npm run build
npm run verify:release
npm run verify:installer
```

其中：

- `verify:release` 覆盖 lint、typecheck、测试、构建和发布前 smoke。
- `verify:installer` 会生成 unpacked packaged app，并用隔离 userData 启动 packaged app 做基础检查。

## Provider 与密钥安全

真实 Provider Catalog、API Key、token、`.env` 和本地 GenericAgent 配置不应提交到仓库。

仓库只保留 `configs/*.example.json` 示例文件。首次运行后，请在应用 UI 中配置真实 Provider / Model。API Key 只应保存在本机配置里，不要写入 README、Issue、截图、日志或提交内容。

Claude Code 和 Summary 当前需要 Anthropic API 形状的 Provider；OpenAI-compatible Provider 默认更适合 GenericAgent，除非你有 Anthropic-compatible relay。

## 公开目录说明

- `src/`：React renderer 源码。
- `electron/`：Electron main / preload / 本地进程与 IPC 逻辑。
- `scripts/`：构建、native module rebuild 和 e2e 验证脚本。
- `configs/*.example.json`：本地配置示例，不包含真实密钥。
- `docs/guides/release-candidate-user-guide.md`：发布候选最小用户指南。

## License

License not specified yet. See `package.json`.
