const fs = require('fs')
const path = require('path')

const SECRET_KEY_PATTERN = /(api[-_]?key|token|authorization|secret|password|credential)/i
const SECRET_VALUE_PATTERN = /(sk-[a-z0-9_-]{12,}|Bearer\s+[a-z0-9._-]{12,}|ANTHROPIC_[A-Z_]*KEY|ANTHROPIC_AUTH_TOKEN)/i

function ensureReportsDir(repo, step) {
  const dir = path.join(repo, 'reports', step)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function createReport(input) {
  const checks = input.checks ?? {}
  return {
    ok: input.ok ?? Object.values(checks).every(Boolean),
    step: input.step,
    startedAt: input.startedAt ?? new Date().toISOString(),
    project: input.project ?? null,
    provider: input.provider ?? null,
    checks,
    score: input.score ?? null,
    failedAt: input.failedAt ?? null,
    reason: input.reason ?? null,
    evidence: input.evidence ?? {}
  }
}

function validateReport(report) {
  const errors = []
  if (typeof report !== 'object' || report == null || Array.isArray(report)) errors.push('report must be an object')
  if (typeof report.ok !== 'boolean') errors.push('ok must be boolean')
  if (!report.step || typeof report.step !== 'string') errors.push('step must be a non-empty string')
  if (!report.startedAt || Number.isNaN(Date.parse(report.startedAt))) errors.push('startedAt must be an ISO date')
  if (typeof report.checks !== 'object' || report.checks == null || Array.isArray(report.checks)) errors.push('checks must be an object')
  if (typeof report.evidence !== 'object' || report.evidence == null || Array.isArray(report.evidence)) errors.push('evidence must be an object')
  if (containsSecret(report)) errors.push('report must not contain secrets')
  return { ok: errors.length === 0, errors }
}

function writeReport(repo, step, reportInput) {
  const report = createReport(reportInput)
  const validation = validateReport(report)
  if (!validation.ok) {
    throw new Error(`Invalid e2e report: ${validation.errors.join('; ')}`)
  }

  const dir = ensureReportsDir(repo, step)
  const filePath = path.join(dir, `${safeTimestamp(report.startedAt)}.json`)
  report.evidence.report = path.relative(repo, filePath).replace(/\\/g, '/')
  const finalValidation = validateReport(report)
  if (!finalValidation.ok) {
    throw new Error(`Invalid e2e report after evidence update: ${finalValidation.errors.join('; ')}`)
  }
  fs.writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return { report, filePath }
}

function scoreStep(input) {
  const assertions = input.assertions ?? []
  const passed = assertions.filter((assertion) => assertion.passed).length
  const blockingFailed = assertions.some((assertion) => assertion.blocking && !assertion.passed)
  const rawHard = assertions.length > 0 ? Math.floor(60 * passed / assertions.length) : 0
  const hard = blockingFailed ? Math.min(rawHard, 30) : rawHard
  const subjective = Math.max(0, Math.min(40, Math.floor(input.subjective ?? 0)))
  const total = hard + subjective
  return {
    hard,
    subjective,
    total,
    rater: input.rater,
    pass: total >= 90 && !blockingFailed,
    blockingFailed
  }
}

function containsSecret(value) {
  if (value == null) return false
  if (typeof value === 'string') return SECRET_VALUE_PATTERN.test(value)
  if (typeof value === 'number' || typeof value === 'boolean') return false
  if (Array.isArray(value)) return value.some(containsSecret)
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key) && child != null && child !== '') return true
    if (containsSecret(child)) return true
  }
  return false
}

function safeTimestamp(value) {
  return value.replace(/[:.]/g, '-').replace(/[^0-9TZ-]/g, '-')
}

module.exports = {
  createReport,
  scoreStep,
  validateReport,
  writeReport
}
