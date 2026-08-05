#!/usr/bin/env node
// DEV-TIME ONLY. Never runs in the hook path — it makes network calls.
//
// Bakes the MODEL_WINDOWS table in hooks/window.mjs from GET /v1/models, the
// only authoritative source for a model's context window. Same contract as
// scripts/calibrate.mjs: measure at dev time, ship constants, never touch the
// network from the guard.
//
//   ANTHROPIC_API_KEY=... node scripts/models.mjs
//
// The window lives in `max_input_tokens` — there is no `context_window` field.
// Do NOT hand-write this table from a docs page or from memory. Model windows
// change when models ship, and a stale-but-plausible entry is worse than a
// missing one: modelCeiling() falls back safely for an unknown model, but a
// wrong number is reported to the user as fact.
//
// IMPORTANT: what this prints is the model's API ceiling, NOT the window Claude
// Code gives its main loop. Those differ — see the header of hooks/window.mjs.

import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic() // picks up ANTHROPIC_API_KEY

// Iterate the pager directly; it auto-paginates. There is no `.data` on the
// returned object to reach into.
const models = []
try {
  for await (const m of client.models.list()) models.push(m)
} catch (err) {
  console.error(`cannot reach the Models API: ${err.message}\n`)
  console.error('Set ANTHROPIC_API_KEY. Note the Models API is absent on Bedrock, Vertex, and Foundry.')
  process.exit(2)
}

if (!models.length) {
  console.error('the Models API returned no models — refusing to emit an empty table')
  process.exit(2)
}

// max_input_tokens shipped in Mar 2026. An older API version, or a gateway that
// strips unknown fields, would yield a table of undefineds — fail loudly.
const missing = models.filter(m => !Number.isFinite(m.max_input_tokens))
if (missing.length === models.length) {
  console.error('no model reported max_input_tokens — this API version predates the field, or a proxy stripped it')
  process.exit(2)
}

const width = Math.max(...models.map(m => m.id.length))
for (const m of models) {
  console.log(
    `${m.id.padEnd(width)}  in=${String(m.max_input_tokens ?? '?').padStart(9)}` +
    `  out=${String(m.max_tokens ?? '?').padStart(7)}  ${m.display_name}`
  )
}
if (missing.length) {
  console.log(`\n${missing.length} model(s) reported no max_input_tokens, omitted below:`)
  for (const m of missing) console.log(`  ${m.id}`)
}

// Print the literal rather than rewriting window.mjs, so new constants always
// land in a reviewed diff — exactly how calibrate.mjs hands off.
console.log('\n--- paste into hooks/window.mjs ---')
console.log('export const MODEL_WINDOWS = {')
for (const m of models) {
  if (!Number.isFinite(m.max_input_tokens)) continue
  console.log(`  '${m.id}': ${m.max_input_tokens.toLocaleString('en-US').replace(/,/g, '_')},`)
}
console.log('}')
console.log(`\n${models.length} models | generated from GET /v1/models`)
