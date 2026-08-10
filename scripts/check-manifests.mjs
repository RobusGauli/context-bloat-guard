// Fails loudly when the three manifests drift, instead of shipping the drift.
// Wired into `npm test` — see package.json.
//
// What is checked, and why (issue #5):
//
// - package.json and plugin.json must agree on `version`. plugin.json is the
//   source of truth for the plugin's version: per the Claude Code docs
//   (plugins-reference, "Version management"), the version is resolved from
//   plugin.json first, the marketplace entry second, then the source's commit
//   SHA — and "if also set in the marketplace entry, plugin.json wins".
//   package.json restates it only because npm requires a version field.
//
// - marketplace.json must NOT carry a version on this plugin's entry. It would
//   be inert while plugin.json has one, and a second thing to forget to bump.
//
// - marketplace.json's `description` must be byte-identical to plugin.json's.
//   The duplication is deliberate: the marketplace listing is read from
//   marketplace.json alone, before the plugin source is fetched, and the docs
//   define no inheritance from plugin.json for an omitted description. So the
//   string exists twice on purpose — and this check is what keeps them equal.
import { readFileSync } from 'node:fs'

const read = p => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'))
const pkg = read('../package.json')
const plugin = read('../.claude-plugin/plugin.json')
const market = read('../.claude-plugin/marketplace.json')

const errors = []

if (!plugin.version) {
  errors.push('plugin.json has no version — it is the source of truth and must have one')
}
if (pkg.version !== plugin.version) {
  errors.push(`version mismatch: package.json ${pkg.version} vs plugin.json ${plugin.version}`)
}

const entry = market.plugins.find(p => p.name === plugin.name)
if (!entry) {
  errors.push(`marketplace.json has no entry named ${plugin.name}`)
} else {
  if ('version' in entry) {
    errors.push('marketplace.json entry carries a version — remove it, plugin.json wins and this would only drift')
  }
  if (entry.description !== plugin.description) {
    errors.push('marketplace.json description has drifted from plugin.json')
  }
}

if (errors.length) {
  for (const e of errors) console.error('manifest check: ' + e)
  process.exit(1)
}
console.log('manifest check: package.json, plugin.json, marketplace.json agree')
