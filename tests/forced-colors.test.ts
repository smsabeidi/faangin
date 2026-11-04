import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const directory = join(import.meta.dirname, '../src/renderer/src')
const read = (name: string) => readFileSync(join(directory, name), 'utf8')
const forced = read('forced-colors.css')
const block = forced.slice(forced.indexOf('@media (forced-colors: active)'))
const rules = [...block.matchAll(/^\s{2}([^{}\n]+)\{([^}]*)\}/gm)].map(match => ({ selectors: match[1].split(',').map(selector => selector.trim()), body: match[2] }))
const others = readdirSync(directory).filter(name => name.endsWith('.css') && name !== 'forced-colors.css').map(read).join('\n')

test('the forced-colors stylesheet loads after every other stylesheet so its overrides win', () => {
  const imports = [...read('main.tsx').matchAll(/^import '(\.\/[^']+\.css)'/gm)].map(match => match[1])
  assert.equal(imports.at(-1), './forced-colors.css'); assert.equal(imports.filter(name => name === './forced-colors.css').length, 1)
})

test('every state-bearing control that depends on a background or shadow has a forced-colors rule', () => {
  const covered = new Set(rules.flatMap(rule => rule.selectors))
  for (const selector of ['.toggle-track', '.toggle-input:checked + .toggle-track', '.meter-bars span.lit', '.status-dot.live', '.nav-button.selected', '.mode-switch button.active', '.segmented button.active', '.settings-nav > button.selected', '.source-option.selected', '.theme-option.selected']) assert.ok(covered.has(selector), selector)
  assert.ok(rules.length >= 8)
})

test('the selectors it restates still exist in the app stylesheets, so a rename cannot silently leave a control unstyled', () => {
  for (const selector of new Set(rules.flatMap(rule => rule.selectors))) {
    const needle = selector.replace(/ !important/, '')
    const tail = needle.split(/\s+/).filter(part => part !== '>' && part !== '+').at(-1)!
    assert.ok(others.includes(tail), `${selector} is not defined in the app stylesheets`)
  }
})

test('state is drawn with system colours and outlines only, which forced-colors mode preserves', () => {
  for (const rule of rules) {
    for (const declaration of rule.body.split(';').map(item => item.trim()).filter(Boolean)) {
      const [property, value] = declaration.split(':').map(part => part.trim())
      assert.match(property, /^(?:background|border-color|outline|outline-offset)$/, declaration)
      if (property !== 'outline-offset') assert.match(value, /\b(?:Canvas|CanvasText|Highlight|HighlightText|GrayText)\b/, declaration)
    }
  }
  // The dots outrank the overlay brand-line rules (specificity 0,4,0) only with !important.
  for (const rule of rules.filter(rule => rule.selectors.some(selector => selector.includes('status-dot')))) assert.match(rule.body, /!important/)
  assert.doesNotMatch(block, /forced-color-adjust|box-shadow|scrollbar/)
})
