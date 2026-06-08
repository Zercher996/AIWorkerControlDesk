# 发布候选最小用户指南

这份指南面向第一次试用 AIWorkerControlDesk 的开发者，说明它是什么、怎么开始、出错时如何自救。

## 它是什么

AIWorkerControlDesk 是一个本地 AI Worker 调度台。它帮助你在多个本地 Project 中启动、观察、接管和续工真实的 Claude Code / CLI Worker Session。

它的核心不是「和一个聊天窗口对话」，而是回答这些问题：

- 哪个 Project 正在跑 AI Worker？
- 哪个 Session 正在工作、等待、失败或已经完成？
- 当前 Session 做了什么，我是否需要接管？
- 上一次 Session 结束后，能否基于 Summary 新开一个真实 Session 继续？

## 它不是什么

AIWorkerControlDesk 不是这些产品：

- 不是普通 Claude Code GUI 或聊天产品。
- 不是 IDE、文件管理器或 Git 工作台。
- 不是 MCP 管理器、Memory 主界面或通用插件系统。
- 不是 DAG、workflow、任务队列或通用 Agent 编排平台。
- 不是 Claude Code TUI 的复刻。

发布候选版只围绕现有 Project、Provider、Worker、Session、Radar、右栏 AI 输入输出页、原生 PTY 接管和 Summary 续工收口。

## 试用前准备

你需要准备：

1. 一个本地项目目录，作为 Project。
2. 本机可用的 Claude Code。
3. 一个可用于 Claude Code 的 Provider / Model 配置。
4. 如果要试用 GenericAgent，需要先准备本机 GenericAgent 配置；否则可以先只使用 Claude Code Worker。

不要把 API key、token 或密码写进截图、文档、报告或提交内容。Provider API key 只应保存在本地 Provider Catalog，并且 UI 默认隐藏。

## 本地启动、安装包与发布前验证

如果你只是开发或调试，可以按开发态启动：

```bash
npm install
npm run dev
```

如果你想验证 production build，可以在源码目录运行：

```bash
npm run build
npx electron .
```

如果你想生成可双击的 Windows 版本，使用：

```bash
npm run pack:win
```

生成后主要看两个产物：

- `dist/*.exe`：Windows 安装器，适合普通试用者双击安装。
- `dist/win-unpacked/AIWorkerControlDesk.exe`：免安装版本，适合开发者快速验收打包后的应用。

当前安装包不包含真实 Provider Catalog、真实 GenericAgent 配置、`.env`、reports 或任何本地密钥。首次启动后仍需要在本机 UI 里配置 Provider / Model。

发布前完整自检入口是：

```bash
npm run verify:release
```

该命令会覆盖 lint、typecheck、测试、构建、practical-loop 和 release practical smoke。它验证的是 production build output via Electron。

打包后应用自检入口是：

```bash
npm run verify:installer
```

该命令会生成 `dist/win-unpacked/AIWorkerControlDesk.exe`，并用隔离 userData 启动 packaged app，检查 `window.workerDesk`、Project / Provider / GenericAgent 配置读取和受控失败诊断。

如果需要分段定位问题，可以按顺序运行：

```bash
npm run lint
npm run typecheck
npm run test
npm run build
npm run verify:practical
node scripts/e2e/release-smoke.cjs --practical
npm run verify:installer
```

## 模型配置说明：只有 Key + URL 时怎么配置

如果你手里只有一个 API Key 和一个服务 URL，先不要猜 Provider 字段。模型接入的本质是四个问题：这个 URL 连到哪里、它说哪种协议、上游认识哪个模型名、这个连接能给哪个 Worker 用。

### Key + URL 接入决策树

从你手里的材料出发，按下面顺序判断：

```text
我有 Key + URL
  ├─ 服务文档写 Anthropic、Claude、Messages API 或 Anthropic-compatible？
  │    └─ 是：按 anthropic 配置，可用于 Claude Code / Summary / GenericAgent native_claude
  ├─ 服务文档写 OpenAI Chat Completions、/v1/chat/completions 或 OpenAI-compatible？
  │    └─ 是：按 openai_chat 配置，优先只用于 GenericAgent native_oai
  ├─ 服务文档写 OpenAI Responses、/v1/responses？
  │    └─ 是：按 openai_responses 配置，优先只用于支持 Responses 的 GenericAgent 路径
  ├─ 这是本地或公司 relay？
  │    ├─ relay 对外模拟 Anthropic：按 anthropic 配，可用于 Claude Code
  │    └─ relay 对外模拟 OpenAI：按 openai_chat/openai_responses 配，默认只用于 GenericAgent
  └─ 文档没说协议形状？
       └─ 先不要勾选 Claude Code；先确认接口形状或用受控测试验证
```

判断结论只有三类：

| 结论 | 下一步 |
|------|--------|
| Anthropic 形状 | 可以配置给 Claude Code；这是最短路径。 |
| OpenAI 形状 | 先配置给 GenericAgent；不要强行给 Claude Code。 |
| 不确定 | 先查服务文档或做小范围验证，不要把它作为默认启动连接。 |

### 四层心智模型

不要把「管理模型」理解成字段表。它其实是在回答四层问题：

| 层级 | 回答的问题 | 对应配置 | 常见错误 |
|------|------------|----------|----------|
| 连接层 | 请求发到哪里、用什么凭证进门？ | Base URL、API Key | 连接失败、401、找不到服务。 |
| 协议层 | 这个 URL 听得懂哪种请求语言？ | Provider API Format：`anthropic` / `openai_chat` / `openai_responses` | Claude Code 不兼容、请求格式错误、404/400。 |
| 模型层 | 上游认识哪个模型名字？ | 模型 ID、默认模型 | 模型不存在、403、model not found。 |
| 用途层 | 这个连接给哪个 Worker 使用？ | 可用于：Claude Code / GenericAgent / Summary | 左栏看不到模型、启动前提示不兼容。 |

排查时也按这四层倒着看：先看用途是否选对，再看模型 ID，再看协议形状，最后看 URL 和 Key。

### 先确认 URL 支持哪种接口形状

同一个“模型服务”可能提供不同接口形状。AIWorkerControlDesk 里最关键的不是厂商名，而是这个 URL 接受哪种请求格式。

| 你拿到的服务类型 | 能否直接用于 Claude Code | 推荐配置 |
|------------------|--------------------------|----------|
| Anthropic 官方或 Anthropic-compatible URL | 可以 | `apiFormat` 选 `anthropic`，勾选 `Claude Code`。 |
| 外部服务已经把 OpenAI 请求转换成 Anthropic Messages | 可以 | 仍按 Anthropic-compatible 配：`apiFormat` 选 `anthropic`。 |
| 只有 OpenAI-compatible Chat Completions URL | 不能直接给 Claude Code 用 | 只给 GenericAgent 的 `native_oai` 用，或先接入能转成 Anthropic 形状的 relay。 |
| 只有 OpenAI Responses URL | 不能直接给 Claude Code 用 | 只给支持 Responses 的 GenericAgent 路径用，Claude Code 仍需要 Anthropic 形状。 |
| 不确定接口形状 | 暂不要乱填 | 先看服务商文档里是否写 Anthropic Messages、OpenAI Chat Completions 或 OpenAI Responses。 |

规则很简单：Claude Code 和 Summary 当前需要 `anthropic` API 形状；GenericAgent 才可以按配置使用 `openai_chat` 或 `openai_responses`。

### 在“管理模型”里填写基础连接

打开「管理模型」后，新增一个连接，默认只需要先填这几项：

| 字段 | 怎么填 | 例子 / 说明 |
|------|--------|-------------|
| 连接名称 | 你自己能看懂的名字 | 例如“公司中转 Anthropic”“本地 Relay”“测试 OpenAI 兼容源”。 |
| Base URL | 服务商给你的 URL | 填服务商文档提供的 base URL，不要自己拼路径；如果服务商要求 `/v1`，按它给的完整 base URL 填。 |
| API Key | 服务商给你的 key | 只在应用里输入，不要写入文档、截图、Issue 或提交。 |
| 模型 ID | 服务商文档里的模型 id | 必须和上游服务识别的一致，大小写和前缀都不要改。 |
| 默认模型 | 从已填写的模型里选一个 | 新建时通常就是刚填的第一个模型。 |
| 可用于 | 选择这个连接给谁用 | Claude Code 只适合 Anthropic 形状；GenericAgent 可按协议支持选择。 |

保存后回到左栏，选择这个连接和模型，再启动 Session。

### 常见配置场景

#### 场景 1：Anthropic 官方或 Anthropic-compatible 服务

适合目标：Claude Code、Summary、GenericAgent `native_claude`。

填写方式：

```text
连接名称：能看懂即可
Base URL：服务商提供的 Anthropic base URL
API Key：在应用输入真实 key
模型 ID：服务商支持的 Claude / Anthropic-compatible 模型 id
默认模型：选择上面的模型
可用于：勾选 Claude Code；需要时再勾选 GenericAgent
高级设置 / Provider API Format：anthropic
```

这是最推荐的 Claude Code 配置方式。

#### 场景 2：你有一个本地或公司 relay

适合目标：取决于 relay 对外暴露的接口形状。

如果 relay 对外模拟 Anthropic Messages：

```text
Base URL：relay 暴露给本机或内网的 base URL
API Key：relay 要求的 key；如果 relay 不要求 key，也按应用当前校验填写一个本地占位 key，避免空 key 配置
模型 ID：relay 映射后的模型 id
Provider API Format：anthropic
可用于：Claude Code / Summary / GenericAgent native_claude
```

如果 relay 对外只模拟 OpenAI Chat Completions 或 Responses：

```text
Provider API Format：openai_chat 或 openai_responses
可用于：优先只给 GenericAgent 使用
不要直接勾选 Claude Code，除非 relay 明确支持 Anthropic 形状
```

#### 场景 3：只有 OpenAI-compatible 的 Key + URL

适合目标：GenericAgent，不适合直接跑 Claude Code。

填写方式：

```text
连接名称：能看懂即可
Base URL：OpenAI-compatible base URL
API Key：在应用输入真实 key
模型 ID：上游支持的模型 id
可用于：GenericAgent
高级设置 / Provider API Format：openai_chat 或 openai_responses
GenericAgent 高级 / 会话类型：native_oai
```

如果你想让 Claude Code 使用这个上游，需要先有一个 Anthropic-compatible 转换层；否则 Claude Code 可能启动失败、请求失败或返回模型不兼容错误。

#### 场景 4：从 CCswitch 导入

如果你本机已经通过 CCswitch 管理 Claude provider，可以在「管理模型」里点击「从 CCswitch 导入」。

导入规则：

- 只读取 Claude 类型 provider。
- 只显示脱敏预览，不显示完整 token。
- 同一连接下的多个模型会合并到同一个 Provider 的模型列表。
- 导入后仍建议检查：连接名称、Base URL、默认模型、可用于。

### 错误反推表

如果配置保存成功但启动或请求失败，优先按现象反推是哪一层错了：

| 现象 / 错误方向 | 优先怀疑哪一层 | 怎么处理 |
|-----------------|----------------|----------|
| 左栏看不到刚保存的模型。 | 用途层 | 检查“可用于”是否勾选了当前 Worker；Claude Code 还要确认协议是 `anthropic`。 |
| 启动前提示连接或模型与 Claude Code 不兼容。 | 协议层 / 用途层 | Claude Code 只能走 Anthropic 形状；OpenAI-compatible 先给 GenericAgent，或接 Anthropic-compatible relay。 |
| 请求返回 401 / unauthorized。 | 连接层 | API Key 可能错、过期、没权限，或服务要求另一种鉴权 key。 |
| 请求返回 403 / forbidden。 | 模型层 / 连接层 | Key 可能没有该模型权限；Model ID 可能不属于这个账号；也可能是 Provider 环境里的模型和启动模型冲突。 |
| 请求返回 404 / not found。 | 连接层 / 协议层 | Base URL 可能路径错，或把 OpenAI URL 当 Anthropic URL 用。 |
| 请求返回 400 / invalid request。 | 协议层 | API Format 多半不匹配：例如用 OpenAI-compatible URL 配成 Anthropic，或反过来。 |
| 连接超时、ECONNREFUSED、fetch failed。 | 连接层 | URL 不可访问、本地 relay 没启动、端口不对、网络或代理不可达。 |
| model not found / unknown model。 | 模型层 | Model ID 和上游文档不一致，或该模型不在当前服务区域 / 当前账号下。 |
| Summary 可用但 Claude Code 不可用。 | 用途层 / 协议层 | 检查 Claude Code 是否勾选、协议是否 `anthropic`，以及模型是否支持 Claude Code 当前路径。 |
| GenericAgent 可用但 Claude Code 不可用。 | 协议层 | 这通常说明连接是 OpenAI-compatible；GenericAgent 能用不代表 Claude Code 能用。 |

定位时不要一次改很多项。每次只改一层：先改“可用于”，不行再改模型 ID，再改 API Format，最后再换 Base URL 或 Key。

### 一个最小可行测试

拿到陌生 Key + URL 时，建议先用最小配置验证：

1. 只新增一个连接，不同时导入多个 Provider。
2. 只填一个模型 ID，不先加多个模型。
3. 如果文档明确是 Anthropic-compatible，先只勾选 Claude Code。
4. 如果文档明确是 OpenAI-compatible，先只勾选 GenericAgent。
5. 启动一个最简单任务，例如让 Worker 输出一句话。
6. 成功后再添加更多模型、Summary 或 GenericAgent 用途。

这样做的好处是：失败时只有一个变量，不会同时怀疑 Key、URL、模型、协议和 Worker。

### 一个脱敏示例

下面示例只说明字段形状，不要把真实 key 写进文档。实际 API Key 应通过应用界面输入，并保存在本地 Provider Catalog。

```json
{
  "name": "Example Anthropic Compatible Provider",
  "apiFormat": "anthropic",
  "baseUrl": "https://example-provider.invalid",
  "models": [
    {
      "id": "example-claude-model",
      "displayName": "Example Claude Model"
    }
  ],
  "defaults": {
    "modelId": "example-claude-model"
  },
  "availability": ["Claude Code", "Summary"]
}
```

注意：

- 示例中不包含 API Key。
- 不要提交真实 Provider Catalog。
- 不要把真实 Base URL、私有 relay 地址或完整 key 写进公开报告。
- Claude Code 和 Summary 当前需要 Anthropic API 形状的 Provider。
- OpenAI-compatible 上游默认只适合 GenericAgent，除非你已经有 Anthropic-compatible 转换层。

### 保存前自检

保存前按下面清单看一遍：

1. `Base URL` 来自服务商文档或你自己的 relay 配置，没有手写猜路径。
2. `Model ID` 和服务商文档完全一致。
3. `API Key` 只输入在应用里，没有粘到文档或截图里。
4. 要跑 Claude Code 时，`Provider API Format` 是 `anthropic`。
5. 只有 OpenAI-compatible 时，不要强行给 Claude Code 用；先给 GenericAgent 或接 relay。
6. 多个模型在同一连接下时，确认“默认模型”选的是你想启动的那个。
7. 如果保存后左栏看不到这个模型，检查“可用于”是否勾选了当前 Worker。

## 首次 click-through 试用路径

建议按下面顺序做一轮人工试用：

1. `npm run dev` 启动应用。
2. 添加或选择一个本地 Project。
3. 打开「管理模型」。
4. 新增 Provider，在基础连接里填写连接名称、Base URL、API Key，并填写模型 ID。
5. 保存 Provider，回到左栏选择该 Provider / Model。
6. 启动 Claude Code Session。
7. 在 Session Radar 中观察状态变化。
8. 在右栏确认能看到 AI 输出、工具事件或可读错误。
9. 输入一条简单任务，确认输入进入当前 Session。
10. Session 结束后生成或选择 Summary。
11. 基于 Summary 继续，确认创建的是新 Session。
12. 如需验证 GenericAgent，再启动单独 GenericAgent 或开启自动协助。
13. 如需验证原生命令，切到同 Session 原生 PTY 接管，并确认没有新建额外 Claude Code 子 Session。

## 主界面怎么理解

应用按三栏理解：

| 区域 | 作用 |
|------|------|
| 左栏 | 选择或添加 Project，选择 Provider / Model，启动 Worker Session。 |
| 中栏 | Session Radar，显示所有 Worker Session 的当前现场。 |
| 右栏 | 当前 Session 的 AI 输入输出页面；必要时可切到同 Session 原生 PTY 接管。 |

普通使用时，优先看中栏 Radar 判断该盯谁，再在右栏处理当前 Session。

## 添加或选择 Project

Project 是本地项目目录，表示 Worker 的工作空间。

首次使用时：

1. 在左栏添加一个本地 Project。
2. 确认 Project 被选中。
3. 后续启动的 Claude Code / GenericAgent Session 会以这个 Project 作为工作目录。

Project 只表示工作空间，不会把应用变成文件浏览器或 Git 管理器。

## 配置 Provider 和 Model

Provider 描述 Worker 如何连接模型服务。发布候选版采用 Provider-first 主路径：Claude Code、GenericAgent 和 Summary 生成都从 Provider Catalog 选择连接和模型。

首次配置建议：

1. 打开 Provider 配置入口。
2. 新增一个连接。
3. 填写连接名称、Base URL、Model ID 和 API Key。
4. 确认该 Provider 对 Claude Code 可用。
5. 保存后回到 Project 启动区域选择该 Provider / Model。

注意事项：

- Claude Code 和 Summary 当前需要 Anthropic API 形状的 Provider。
- GenericAgent 是否可用取决于它的 provider adapter 与模型协议支持。
- API key 默认隐藏；导入预览和报告都不应显示完整密钥。
- 如果保存时报兼容性错误，先检查 apiFormat、Model ID、Base URL 和 Worker 兼容性。

## 启动 Claude Code Session

启动主路径：

1. 选择 Project。
2. 选择 Provider / Model。
3. 选择 Claude Code Worker。
4. 启动 Session。
5. 在中栏 Radar 观察状态变化。
6. 在右栏查看 AI 输出、工具调用、错误、等待状态，并继续输入。

Claude Code 默认走 `native-jsonl` 主路径：真实原生 PTY 进程启动，应用只读 Claude Code 原生 jsonl 并投影成结构化 AI 事件。应用不会写回或修复 Claude Code 原始 jsonl。

## 读懂 Session Radar

Session Radar 用来快速判断当前该关注谁。

常见状态含义：

| 状态 | 含义 | 你可以做什么 |
|------|------|--------------|
| starting | Worker 正在启动。 | 等待启动完成；如果长时间停留，检查 Provider、Claude Code 或本机环境。 |
| running | Worker 正在运行。 | 打开右栏查看输出，必要时继续输入。 |
| waiting | Worker 等待用户输入或确认。 | 点击该 Session，在右栏处理下一步。 |
| failed | Worker 启动或运行失败。 | 查看错误提示，按 Provider / relay / model / Claude Code / pty / jsonl 环节定位。 |
| exited | Worker 已退出。 | 查看历史或生成 Summary。 |
| stopped | Worker 已停止。 | 如需继续，应基于 Summary 新建 Session。 |

Radar 的目标是让你一眼判断哪个 Worker 需要关注，不是任务 DAG 或流程图。

## 右栏 AI 输入输出页

右栏显示当前 Session 的现场，包括：

- 用户输入。
- AI 输出。
- 工具调用和工具结果。
- 权限拒绝或诊断信息。
- 等待、失败或完成状态。

如果工具已经完成但 AI 还没总结，右栏会提示仍在等待 AI 总结。此时不要把它误认为 Session 已完成。

## 原生 PTY 接管

大多数时候，你应该在右栏 AI 输入输出页工作。

当 Claude Code 需要原生交互界面时，例如进入管理类命令、权限确认或 TUI 交互，可以切到原生 PTY 接管。

接管规则：

- 接管复用当前 Claude Code Session 的同一个进程。
- 不会因为 `/plugin`、`/mcp`、`/permissions` 等命令新建额外 Claude Code 子 Session。
- 接管是临时能力，不是默认工作区。
- 切换 Session 时要确认当前选中的 Session，避免把输入发给错误对象。

## 基于 Summary 续工

Session 结束后，如果要继续任务，主路径是：

1. 在历史或 Session 详情中生成或选择 Summary。
2. 点击基于 Summary 继续的入口。
3. 应用创建一个新的真实 Session。
4. 应用把 Summary 写入新 Session 的初始 prompt。
5. 新 Session 按普通 Claude Code Session 继续运行。

这不是恢复原 Claude Code CLI session 的运行态，也不是写回 Claude Code 原始 jsonl。Summary 只是新 Session 的上下文来源。

## GenericAgent 怎么理解

GenericAgent 是第二类真实 CLI Worker，可作为 Claude Code 之外的执行 worker。

发布候选版中，GenericAgent 仍保持轻量边界：

- 它复用 Project、Provider、Session Radar 和 PTY 接管链路。
- 它不是通用 Agent 平台。
- 它不引入 DAG、workflow 或不可见后台编排。
- 如果 Project 开启自动分派，Claude Code 可以把独立任务交给 GenericAgent，并在完成后回传结果。

第一次试用时，可以先只跑 Claude Code Session；确认主路径稳定后，再配置 GenericAgent。

## 常见错误与自救

| 现象 | 可能环节 | 处理建议 |
|------|----------|----------|
| 空配置时无法启动 Session。 | Provider / Model | 先新增 Provider，填写 Base URL、Model ID 和 API Key，并确认兼容 Claude Code。 |
| 提示 Provider not found 或找不到 Provider。 | provider-selection | 回到 Provider 配置，确认当前 Project 启动区选择的是已保存的 Provider。 |
| 提示模型不可用或 403。 | model | 检查 Model ID 是否与上游服务一致；如果 Provider 已通过环境变量指定模型，不要再配置冲突模型。 |
| 请求无法连接或 relay 失败。 | relay / base URL | 检查 Base URL、网络、本地 relay 配置和上游服务是否可访问。 |
| Claude Code 无法启动。 | claude-code | 确认本机能直接运行 Claude Code，并检查应用中的错误提示。 |
| PTY 启动失败。 | pty / node-pty | 检查本机依赖和发布构建环境；如果是发布包问题，需要记录错误并重新跑 release smoke。 |
| 右栏没有结构化输出。 | native-jsonl / jsonl | 确认 Session 是 Claude Code `native-jsonl` 主路径；应用只读 jsonl，不会修复或写回原始文件。 |
| Summary 续工不像恢复原会话。 | Summary | 这是预期行为：续工会新建真实 Session，并把 Summary 作为初始上下文。 |

如果错误提示中出现 provider、relay、model、claude-code、pty 或 jsonl 这类环节名，优先按对应环节排查。

## 试用时如何判断是否成功

一次可信的试用至少应该看到：

1. 能选择 Project。
2. 能选择或新增 Provider / Model。
3. 能启动真实 Claude Code Session。
4. Radar 中状态会变化。
5. 右栏能看到 AI 输出、工具事件或可读错误。
6. 需要时能接管同一个 Session 的原生 PTY。
7. Session 结束后能基于 Summary 新建 Session 继续。
8. 失败时能定位到大致环节，而不是只看到模糊失败。

如果这些都成立，说明发布候选版的最小成功路径成立。

## 承诺与证据矩阵

| 发布候选承诺 | 验证方式 | 证据位置 | 当前边界 |
|--------------|----------|----------|----------|
| 基础代码质量通过 | 自动化 | `npm run lint`、`npm run typecheck`、`npm run test` | 证明源码质量，不代表真实使用体验。 |
| 生产构建可启动 | 自动化 | `npm run verify:release`、`reports/release-smoke/*.json` | 当前是 production build output smoke，不是完整 installer smoke。 |
| practical-loop 主路径无回归 | 自动化 | `reports/practical-loop/*.json` | 证明脚本覆盖链路成立，仍需人工 click-through 复核体验。 |
| Provider 缺失能定位 | 自动化 | `reports/release-practical-smoke/*.json`、`reports/provider-fault/*.json` | 当前重点覆盖 Provider fault，不覆盖所有上游服务错误。 |
| 首次 Provider 配置可自救 | 组件测试 + 人工验证 | `src/components/ProviderCatalogEditor.test.tsx` | 人工试用时仍需确认文案是否足够清楚。 |
| 启动前不兼容提示可读 | 组件测试 + 人工验证 | `src/components/ProjectPanel.test.tsx` | 不做复杂自动诊断，只提示连接或模型与当前 Worker 不兼容。 |
| Summary 续工语义清楚 | practical-loop + 人工验证 | `reports/summary-resume/*.json` | 续工是新建真实 Session，不恢复原 CLI 运行态。 |
| 可交给别人试用 | 文档 + dogfood | `docs/audits/release-candidate/` | 发布前应完成真人 click-through；未完成前只能算待人工验收。 |
