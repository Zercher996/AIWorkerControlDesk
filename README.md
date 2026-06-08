# AIWorkerControlDesk

## 这是什么

AIWorkerControlDesk 是一个本地 AI Worker 调度台，用来在多个本地项目中启动、观察、接管和续工真实的 Claude Code / CLI Worker Session。

它的核心不是「再做一个聊天窗口」，而是帮你一眼看清：哪个项目在跑 Worker、哪个 Session 在等待或失败、当前输出要不要接管、结束后能不能基于 Summary 继续。

## 界面预览

### 主界面：三栏调度，深色 / 浅色双主题

左栏选项目与模型并启动 Worker，中栏是 Session Radar 总览全部会话，右栏是当前 Session 的 AI 输入输出页。深浅主题一键切换。

![深色主题主界面：左栏项目与模型、中栏调度中心、右栏 AI 输入输出页](docs/screenshots/home-dark.png)

![浅色主题主界面：同一三栏布局的亮色版本](docs/screenshots/home-light.png)

### 多会话调度：父子 Session 一屏掌控

中栏 Radar 用「全 / 待 / 进 / 完」分组，把多个并行 Worker 的现场状态收在一处，避免在多个 CLI 窗口之间来回切换、盯花眼。

![功能总览：父 Claude Code 会话与多个子会话并行调度](docs/screenshots/feature-overview.png)

### 调用 GenericAgent：把独立任务分派给通用智能体

开启自动协助后，Claude Code 可以把独立子任务分派给 GenericAgent 通用智能体执行，完成后再把结果自动回传给父会话。

![Claude Code 调用 GenericAgent 通用智能体并自动回传结果](docs/screenshots/dispatch-generic-agent.png)

### 基于 Summary 续工：生成新的上下文窗口继续

Session 结束后，可以先生成 Summary，再基于它新建一个真实 Session 继续任务。续工是「带着上下文重新开一个真实会话」，不是恢复旧 CLI 运行态。

![基于 Session Summary 生成新的上下文窗口继续任务](docs/screenshots/summary-resume.png)

## 怎么跑

1. clone 仓库

```bash
git clone https://github.com/Zercher996/AIWorkerControlDesk.git
cd AIWorkerControlDesk
```

2. 安装依赖

```bash
npm install
```

3. 配置模型 API key

应用启动后，在「管理模型」里新增 Provider，填写 API Key、Base URL 和模型 ID。

如果使用 GPT-5.5，请把模型 ID 配置为你的服务商提供的 GPT-5.5 模型名，并确认该服务的 API Format 与用途匹配。

4. 开发态运行

```bash
npm run dev
```

5. 生产构建运行

```bash
npm run build
npx electron .
```

6. 生成 Windows 安装包

```bash
npm run pack:win
```

生成后可在 `dist/` 中找到 Windows 安装器和免安装版本。

## 用了什么

- AI 模型：GPT-5.5
- Electron + React + TypeScript
- Claude Code / CLI Worker Session
- node-pty 与 xterm.js
- Provider Catalog 本地模型配置
- 主要功能：多项目管理、多 Session 观察、Worker 启动、AI 输出查看、原生 PTY 接管、Summary 续工、Windows 打包

## 注意

不要把 API key、token、`.env`、真实 Provider Catalog、reports、dist 或本地配置提交到仓库。
