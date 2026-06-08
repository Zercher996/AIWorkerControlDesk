import type { SlashAssistBehavior, SlashAssistCategory, SlashAssistEvidence, SlashAssistExecutionMode, SlashAssistItem } from '../../src/types/workerDesk'

type NativeCommand = {
  command: string
  description: string
  evidence: SlashAssistEvidence
  behavior: SlashAssistBehavior
  category: SlashAssistCategory
  aliases?: string[]
}

const CURRENT_CLAUDE_COMMANDS: NativeCommand[] = [
  native('/claude-api', '构建、调试和优化 Claude API / Anthropic SDK 应用', 'claude PTY slash menu', '/claude-api Build, debug, and optimize Claude API / Anthropic SDK apps', undefined, 'send-to-session'),
  native('/review', 'Review a pull request', 'claude PTY slash menu', '/review Review a pull request', undefined, 'send-to-session'),
  native('/simplify', '检查改动代码的复用、质量和效率并修复问题', 'claude PTY slash menu', '/simplify Review changed code for reuse, quality, and efficiency', undefined, 'send-to-session'),
  native('/fewer-permission-prompts', '扫描 transcript 并生成减少权限提示的 allowlist 建议', 'claude PTY slash menu', '/fewer-permission-prompts Scan your transcripts for common read-only Bash and MCP tool calls', undefined, 'send-to-session'),
  native('/init', '初始化项目 Claude 配置', 'claude PTY slash menu', '/init Initialize a new CLAUDE.md file with codebase documentation', undefined, 'send-to-session'),
  native('/add-dir', '添加新的工作目录', 'claude PTY slash menu', '/add-dir Add a new working directory'),
  native('/agents', '管理 agent 配置', 'claude PTY slash menu', '/agents Manage agent configurations'),
  native('/background', '把当前会话转入后台并释放终端', 'claude PTY slash menu', '/background Continue this session in the background and free the terminal'),
  native('/branch', '从当前点创建会话分支', 'claude PTY slash menu', '/branch Create a branch of the current conversation at this point'),
  native('/btw', '提出不打断主会话的快速旁路问题', 'claude PTY slash menu', '/btw Ask a quick side question without interrupting the main conversation', undefined, 'send-to-session'),
  native('/clear', '清空上下文开始新会话，旧会话仍保留在磁盘', 'claude PTY slash menu', '/clear Start a new session with empty context'),
  native('/color', '设置当前会话 prompt bar 颜色', 'claude PTY slash menu', '/color Set the prompt bar color for this session'),
  native('/compact', '压缩当前上下文', 'claude PTY slash menu', '/compact Free up context by summarizing the conversation so far'),
  native('/config', '打开配置面板', 'claude PTY slash menu', '/config Open config panel'),
  native('/context', '以彩色网格查看当前上下文使用情况', 'claude PTY slash menu', '/context Visualize current context usage as a colored grid'),
  native('/copy', '复制 Claude 最近一次响应到剪贴板', 'claude PTY slash menu', '/copy Copy Claude\'s last response to clipboard'),
  native('/diff', '查看未提交改动和 per-turn diff', 'claude PTY slash menu', '/diff View uncommitted changes and per-turn diffs'),
  native('/usage', '查看会话成本、计划用量和活动统计', 'claude PTY slash menu', '/usage (cost) Show session cost, plan usage, and activity stats', ['cost']),
  native('/resume', '恢复历史会话', 'claude PTY slash menu', '/resume (continue) Resume a previous conversation', ['continue']),
  native('/rewind', '恢复代码或对话到之前的检查点', 'claude PTY slash menu', '/rewind (checkpoint) Restore the code and/or conversation to a previous point', ['checkpoint', 'undo']),
  native('/update-config', '配置 Claude Code harness settings.json', 'claude PTY slash menu', '/update-config Use this skill to configure the Claude Code harness via settings.json'),
  native('/security-review', '对当前分支待提交改动做安全审查', 'claude PTY slash menu', '/security-review Complete a security review of the pending changes', undefined, 'send-to-session'),
  native('/status', '显示 Claude Code 状态、版本、模型和工具状态', 'claude PTY slash menu', '/status Show Claude Code status including version, model, account, API connectivity, and tool statuses'),
  native('/model', '查看或切换模型', 'claude PTY slash menu', '/model Set the AI model for Claude Code', undefined, 'app-action'),
  native('/permissions', '查看或管理工具权限', 'claude.exe strings', 'Use /permissions to pre-approve and pre-deny bash, edit, and MCP tools'),
  native('/mcp', '查看或管理 MCP 连接', 'claude.exe strings', 'Ask the user to run /mcp and authenticate manually'),
  native('/plugin', '管理 Claude Code 插件', 'claude PTY slash menu filtered by /pl', '/plugin (plugins) Manage Claude Code plugins', ['plugins']),
  native('/reload-plugins', '激活当前会话中待生效的插件变更', 'claude PTY slash menu filtered by /pl', '/reload-plugins Activate pending plugin changes in the current session'),
  native('/skills', '查看当前可用 Skills', 'claude PTY slash menu filtered by /sk', '/skills List available skills'),
  native('/memory', '查看或编辑 Claude 记忆文件', 'claude current command surface', '/memory'),
  native('/statusline', '配置状态栏显示', 'claude current command surface', '/statusline'),
  native('/tasks', '查看后台任务', 'claude current command surface', '/tasks'),
  native('/powerup', '通过快速交互课程发现 Claude Code 功能', 'claude PTY slash menu', '/powerup Discover Claude Code features through quick interactive lessons'),
  native('/rename', '重命名当前会话', 'claude PTY slash menu', '/rename Rename the current conversation'),
  native('/goal', '设置目标并持续工作直到条件满足', 'claude PTY slash menu', '/goal Set a goal—keep working until the condition is met', undefined, 'send-to-session'),
  native('/hooks', '查看工具事件 hook 配置', 'claude PTY slash menu', '/hooks View hook configurations'),
  native('/keybindings', '打开或创建 keybindings 配置文件', 'claude PTY slash menu', '/keybindings Open or create your keybindings configuration file')
]

export const BUILTIN_CLAUDE_COMMANDS: SlashAssistItem[] = CURRENT_CLAUDE_COMMANDS.map((item, index) => ({
  id: `builtin-command:${item.command}`,
  displayText: item.command,
  insertText: `${item.command} `,
  title: item.command,
  description: item.description,
  kind: 'builtin-command',
  category: item.category,
  scopeLabel: '当前安装',
  groupLabel: '当前 Claude Code 命令',
  confidence: 'native-evidence',
  priority: 2,
  aliases: item.aliases,
  nativeOrder: index,
  behavior: item.behavior,
  executionMode: legacyExecutionModeForBehavior(item.behavior),
  evidence: item.evidence
}))

function legacyExecutionModeForBehavior(behavior: SlashAssistBehavior): SlashAssistExecutionMode {
  if (behavior === 'send-to-session') return 'headless-message'
  if (behavior === 'insert-only') return 'assist-only'
  return 'native-interactive'
}

function native(
  command: string,
  description: string,
  source: string,
  excerpt: string,
  aliases?: string[],
  behavior: SlashAssistBehavior = 'switch-to-native'
): NativeCommand {
  return {
    command,
    description,
    evidence: { source, excerpt },
    behavior,
    category: categoryForNativeBehavior(behavior),
    aliases
  }
}

function categoryForNativeBehavior(behavior: SlashAssistBehavior): SlashAssistCategory {
  if (behavior === 'send-to-session') return 'native-task-command'
  if (behavior === 'app-action') return 'desk-app-action'
  return 'native-management-command'
}
