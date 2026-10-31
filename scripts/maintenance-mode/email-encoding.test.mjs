import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repo = resolve(import.meta.dirname, '..', '..')
const { encodeSubject, encodeBodyBase64 } = await import(`file:///${resolve(repo, 'supabase', 'functions', '_shared', 'mime.ts').replace(/\\/g, '/')}`)

const decodeSubject = (s) => s.split('\r\n ').map((w) => {
  const m = /^=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/.exec(w)
  assert.ok(m, 'valid encoded-word')
  assert.ok(w.length <= 75, 'encoded-word within RFC 2047 limit')
  return Buffer.from(m[1], 'base64').toString('utf8')
}).join('')

test('ASCII subject passes through unchanged', () => {
  const s = 'URGENT: Dangerous Defect Reported - Guard missing'
  assert.equal(encodeSubject(s), s)
})

test('non-ASCII subject round-trips as ASCII-only RFC 2047 words, even when long', () => {
  for (const s of ['\u{1F6A8} URGENT: Dangerous - caf\u00e9 \u26A0\uFE0F', 'Pump \u{1F6A8}'.repeat(30)]) {
    const e = encodeSubject(s)
    assert.match(e, /^[\x20-\x7E\r\n]+$/)
    assert.equal(decodeSubject(e), s)
  }
})

test('body round-trips byte-exact with 76-char ASCII lines, emoji and non-ASCII titles intact', () => {
  const html = '<p>\u26A0\uFE0F \u{1F6A8} Zażółć gęślą jaźń\r\n.leading dot</p>'.repeat(40)
  const e = encodeBodyBase64(html)
  assert.match(e, /^[A-Za-z0-9+/=\r\n]+$/)
  assert.ok(e.split('\r\n').every((l) => l.length <= 76))
  assert.equal(Buffer.from(e.replace(/\r\n/g, ''), 'base64').toString('utf8'), html)
})

test('the real emoji survive subject and HTML encoding and decoding', () => {
  const subject = '\u{1F6A8} URGENT: Dangerous Defect Reported - Guard missing'
  const e = encodeSubject(subject)
  assert.match(e, /^[\x20-\x7E\r\n]+$/)
  assert.equal(decodeSubject(e), subject)
  assert.ok(decodeSubject(e).startsWith('\u{1F6A8}'))
  const html = '<p>\u26A0\uFE0F This defect requires your URGENT ATTENTION</p>'
  const back = Buffer.from(encodeBodyBase64(html).replace(/\r\n/g, ''), 'base64').toString('utf8')
  assert.equal(back, html)
  assert.ok(back.includes('\u26A0\uFE0F'))
})

for (const file of [
  resolve(repo, 'supabase', 'functions', 'notify-defect', 'index.ts'),
  resolve(repo, 'supabase-testing', 'supabase', 'functions', 'prodcheck-notify-defect', 'index.ts'),
]) {
  test(`handler source has genuine emoji (no mojibake), declares UTF-8/base64 and encodes the subject: ${file.split('\\').slice(-2)[0]}`, () => {
    const src = readFileSync(file, 'utf8')
    const nonAscii = [...src].filter((c) => c.codePointAt(0) > 127).map((c) => c.codePointAt(0).toString(16).toUpperCase())
    // Exactly: siren, clipboard, warning sign + variation selector. Any mojibake would add U+00F0/U+00E2/U+0178 etc.
    assert.deepEqual(nonAscii, ['1F6A8', '1F4CB', '26A0', 'FE0F'])
    assert.ok(src.includes('`\u{1F6A8} URGENT: ${priorityLabel}'))
    assert.ok(src.includes('font-size: 18px;">\u26A0\uFE0F This defect requires your URGENT ATTENTION'))
    assert.doesNotMatch(src, /[\u00C0-\u00FF\u0152-\u0192\u2018-\u203A]/)
    assert.match(src, /Subject: \$\{encodeSubject\(subject\)\}/)
    assert.match(src, /Content-Type: text\/html; charset=UTF-8/)
    assert.match(src, /Content-Transfer-Encoding: base64/)
    assert.match(src, /encodeBodyBase64\(html\)/)
    assert.match(src, /<meta charset="UTF-8">/)
    assert.match(src, /findDivisionAdminEmails\(supabase, divisionId\)/)
    assert.match(src, /getDefectNotificationSafety/)
  })
}
