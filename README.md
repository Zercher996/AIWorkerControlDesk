# AIWorkerControlDesk

## 这是什么

AIWorkerControlDesk 是一个本地 AI Worker 调度台，用来在多个本地项目中启动、观察、接管和续工真实的 Claude Code / CLI Worker Session。

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
