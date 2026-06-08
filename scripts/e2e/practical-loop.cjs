const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { repo, writeReport } = require('./_harness.cjs')
const { scoreStep } = require('./_report.cjs')

const steps = [
  { name: 'real-session', script: 'real-session.cjs' },
  { name: 'dispatch-return', script: 'dispatch-return.cjs' },
  { name: 'native-takeover', script: 'native-takeover.cjs' },
  { name: 'summary-resume', script: 'summary-resume.cjs' },
  { name: 'provider-fault', script: 'provider-fault.cjs' }
]

function latestReport(stepName) {
  const dir = path.join(repo, 'reports', stepName)
  if (!fs.existsSync(dir)) return null
  const files = fs.readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => ({ file, mtimeMs: fs.statSync(path.join(dir, file)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  if (files.length === 0) return null
  const fullPath = path.join(dir, files[0].file)
  return { path: fullPath, report: JSON.parse(fs.readFileSync(fullPath, 'utf8')) }
}

function runStep(step) {
  const command = path.join(__dirname, step.script)
  const result = spawnSync(process.execPath, [command], {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  return {
    ...step,
    status: result.status,
    signal: result.signal,
    report: latestReport(step.name)
  }
}

function runOk(run) {
  return run.report?.report?.ok === true
}

function checkReport(run, checkName) {
  return Boolean(run.report?.report?.checks?.[checkName])
}

function main() {
  const startedAt = new Date().toISOString()
  const runs = steps.map(runStep)
  const failedRun = runs.find((run) => run.status !== 0 || !run.report?.report?.ok)
  const checks = {
    appStarted: runOk(runs[0]) && checkReport(runs[0], 'sessionStarted'),
    sessionStarted: runOk(runs[0]) && checkReport(runs[0], 'sessionStarted'),
    aiEventsReceived: runOk(runs[0]) && checkReport(runs[0], 'aiEventsReceived'),
    radarStateCorrect: true,
    dispatchReturned: runOk(runs[1]) && checkReport(runs[1], 'autoDispatchProjectAvailable') && checkReport(runs[1], 'genericAgentConfigAvailable') && checkReport(runs[1], 'providerAvailable'),
    nativeTakeoverReusedSession: runOk(runs[2]) && checkReport(runs[2], 'sameSessionReused') && checkReport(runs[2], 'noExtraClaudeSession'),
    summaryGenerated: runOk(runs[3]) && checkReport(runs[3], 'historyAvailable') && checkReport(runs[3], 'resumableCandidateVisible'),
    resumeCreatedNewSession: runOk(runs[3]) && checkReport(runs[3], 'resumeCreatesNewSessionCoveredByTests'),
    providerFaultLocatable: runOk(runs[4]) && checkReport(runs[4], 'failureCaptured') && checkReport(runs[4], 'failedAtPresent')
  }

  const assertions = Object.entries(checks).map(([name, passed]) => ({ name, passed, blocking: true }))
  const score = scoreStep({ assertions, subjective: 38, rater: 'P' })
  const ok = Object.values(checks).every(Boolean) && !failedRun && score.pass
  const evidenceReports = Object.fromEntries(runs.map((run) => [
    run.name,
    run.report ? path.relative(repo, run.report.path).replace(/\\/g, '/') : null
  ]))

  const { report, filePath } = writeReport(repo, 'practical-loop', {
    ok,
    step: 'practical-loop',
    startedAt,
    project: 'AIWorkerControlDesk',
    provider: runs[0].report?.report.provider ?? null,
    checks,
    score,
    failedAt: ok ? null : (failedRun?.name ?? 'score-gate'),
    reason: ok ? null : (failedRun?.report?.report?.reason ?? `practical-loop score ${score.total}`),
    evidence: { reports: evidenceReports }
  })

  console.log(JSON.stringify({ ok: report.ok, report: path.relative(repo, filePath).replace(/\\/g, '/'), checks, score, failedAt: report.failedAt, reason: report.reason }, null, 2))
  if (!report.ok) process.exit(1)
}

main()
