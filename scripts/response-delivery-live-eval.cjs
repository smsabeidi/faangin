/* Explicitly opted-in paired generation: existing encrypted connection, public synthetic text only. */
const { app, safeStorage } = require('electron')
const { DatabaseSync } = require('node:sqlite')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
require('tsx/cjs')
const { loadBaselineCompiler, runLiveEvaluation, evaluationReasoningTransport } = require('./response-delivery-eval.ts')
const { DELIVERY_FIXTURES } = require('./response-delivery-fixtures.ts')
const { HOLDOUT_FIXTURES } = require('./response-delivery-holdout.ts')
const { DEFAULT_SETTINGS } = require('../src/shared/types.ts')
app.setName('Faangin')
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'faangin-delivery-live-'))
app.setPath('userData', runtime)
async function run() {
  if (process.env.FAANGIN_DELIVERY_LIVE !== '1') throw new Error('Explicit FAANGIN_DELIVERY_LIVE=1 opt-in is required.')
  const fixtureSuite = process.env.FAANGIN_DELIVERY_SUITE || 'development'
  if (!['development', 'holdout'].includes(fixtureSuite)) throw new Error('Unknown evaluation suite.')
  const fixtures = fixtureSuite === 'holdout' ? HOLDOUT_FIXTURES : DELIVERY_FIXTURES
  const savedDirectory = path.join(os.homedir(), 'Library/Application Support/Faangin')
  const keyFile = path.join(savedDirectory, 'openai.key.enc')
  if (!safeStorage.isEncryptionAvailable() || !fs.existsSync(keyFile)) throw new Error('The saved encrypted OpenAI connection is unavailable.')
  let model = process.env.FAANGIN_DELIVERY_MODEL || DEFAULT_SETTINGS.fastModel
  if (!process.env.FAANGIN_DELIVERY_MODEL && fs.existsSync(path.join(savedDirectory, 'faangin.sqlite'))) {
    const db = new DatabaseSync(path.join(savedDirectory, 'faangin.sqlite'), { readOnly: true })
    try { const row = db.prepare("SELECT json_extract(json, '$.fastModel') AS model FROM settings WHERE id=1").get(); if (typeof row?.model === 'string') model = row.model } finally { db.close() }
  }
  const reasoningOverride = process.env.FAANGIN_DELIVERY_REASONING
  evaluationReasoningTransport(model, reasoningOverride)
  const apiKey = safeStorage.decryptString(fs.readFileSync(keyFile))
  const baseline = loadBaselineCompiler(path.resolve(__dirname, '..'))
  try {
    const reportPath = process.env.FAANGIN_DELIVERY_REPORT || `/private/tmp/faangin-response-delivery-${fixtureSuite === 'holdout' ? 'holdout-' : ''}live.json`
    const selectedCaseIds = process.env.FAANGIN_DELIVERY_CASES?.split(',').filter(Boolean)
    const report = await runLiveEvaluation({ baseline: baseline.compiler, apiKey, model, revision: baseline.revision, reportPath, selectedCaseIds, fixtures, fixtureSuite, reasoningOverride, onProgress: progress => console.log(JSON.stringify(progress)) })
    console.log(JSON.stringify({ complete: true, model, fixtureSuite, reasoningOverride: report.reasoningOverride, trialCount: report.trials.length, automaticDispositionGate: report.automaticDispositionGate, reportPath }))
    if (!report.automaticDispositionGate.current) process.exitCode = 1
  } finally { baseline.cleanup() }
}
app.whenReady().then(run).catch(error => { console.error(JSON.stringify({ failed: true, code: typeof error?.code === 'string' ? error.code : 'evaluation_error', message: /^Explicit |^The saved encrypted/.test(error.message) ? error.message : 'Synthetic evaluation could not complete; no credentials or private session contents were printed.' })); process.exitCode = 1 }).finally(() => { fs.rmSync(runtime, { recursive: true, force: true }); app.exit(process.exitCode || 0) })
