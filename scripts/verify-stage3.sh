#!/usr/bin/env bash

# Stage 3 ProviderCatalog 全量验证脚本
# 用途：在提交前运行所有自动化检查，确保代码质量

set -e  # 遇到错误立即退出

echo "=========================================="
echo "🚀 Stage 3 ProviderCatalog 全量验证"
echo "=========================================="
echo ""

# 1. Lint 检查
echo "📋 [1/4] 运行 ESLint 代码规范检查..."
if npm run lint; then
  echo "✅ Lint 检查通过"
else
  echo "❌ Lint 检查失败，请修复代码规范问题"
  exit 1
fi
echo ""

# 2. TypeScript 类型检查
echo "🔍 [2/4] 运行 TypeScript 类型检查..."
if npm run typecheck; then
  echo "✅ 类型检查通过"
else
  echo "❌ 类型检查失败，请修复类型错误"
  exit 2
fi
echo ""

# 3. 单元测试
echo "🧪 [3/4] 运行单元测试..."
if npm run test; then
  echo "✅ 单元测试通过"
else
  echo "❌ 单元测试失败，请修复测试用例"
  exit 3
fi
echo ""

# 4. 构建检查
echo "🔨 [4/4] 运行生产构建..."
if npm run build; then
  echo "✅ 构建成功"
else
  echo "❌ 构建失败，请检查构建配置和代码"
  exit 4
fi
echo ""

# 全部通过
echo "=========================================="
echo "✅ Stage 3 ProviderCatalog 全量验证通过"
echo "=========================================="
echo ""

# 手工验收清单
echo "📝 手工验收清单（需人工执行）："
echo ""
echo "1. 启动开发服务器："
echo "   npm run dev"
echo ""
echo "2. 打开应用，进入 Provider 配置界面"
echo ""
echo "3. 添加一个新 Provider："
echo "   - 类型选择 'claude-code' 或 'generic-agent'"
echo "   - 填写必填字段（name, displayName, executablePath 等）"
echo "   - 点击保存"
echo ""
echo "4. 新建 Session："
echo "   - 在 Session 创建界面选择刚添加的 Provider"
echo "   - 填写项目路径和初始 prompt"
echo "   - 点击启动"
echo ""
echo "5. 验证 Worker 启动和输出："
echo "   - Claude Code: 检查终端显示 CC 启动日志和 prompt"
echo "   - Generic Agent: 检查终端显示 GA 启动日志和输出"
echo "   - 确认输入框可用，能发送消息"
echo "   - 确认状态显示正确（running/idle/error）"
echo ""
echo "6. 多 Session 并行测试："
echo "   - 创建第二个 Session（可选不同 Provider）"
echo "   - 切换 Session，确认输入输出不串"
echo "   - 确认终端内容正确切换"
echo ""
echo "=========================================="
echo "🎉 自动化验证完成，请继续手工验收"
echo "=========================================="
