#!/usr/bin/env node
/*
 * Phase 1 parity harness.
 *
 * Compares the standalone C core in src/ with fuzzysort 4.0.2 (the cloned
 * reference implementation) at three layers:
 *   1. target/query normalization
 *   2. word-beginning indexes
 *   3. boolean match, raw score, normalized score, and indexes
 *
 * Run from the project root:
 *   make test-phase1
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '../..')
const cli = resolve(projectRoot, 'build/fuzzy_cli')
const referencePath = resolve(projectRoot, '../fuzzysort/fuzzysort.js')

const fuzzysort = (await import(new URL(`file://${referencePath}`))).default

// ---------------------------------------------------------------------------
// fuzzysort normalization reference (copied from fuzzysort.js:1461-1463)
// ---------------------------------------------------------------------------
const remapFrom = '\\"`‘’‚‛“”„‟«»‹›‐–—−⁄∕…øØłŁđĐðÐıħĦŧŦ'
const remapTo   = "/''''''''''''''----//.oOlLdDdDihHtT"
const remappings = Object.create(null)
for(let i = 0; i < remapFrom.length; i++) remappings[remapFrom[i]] = remapTo[i]

function remapCharacter(char) {
  let r = remappings[char]
  if(r !== undefined) return r
  if(char.charCodeAt(0) < 128) return char
  r = char.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  return r.length === 1 ? r : char
}
function remapChars(value) {
  return /[^\x00-\x7F]|[\\"`]/.test(value)
    ? value.replace(/[\s\S]/g, remapCharacter)
    : value
}
function normalizeQueryReference(query) {
  return remapChars(query).trim().toLowerCase()
}
function normalizeTargetReference(target) {
  return remapChars(target).toLowerCase()
}
function effectiveEmpty(query) {
  return remapChars(query).trim() === ''
}
function beginningsReference(target) {
  const value = remapChars(target)
  const result = []
  let wasUpper = false
  let wasAlnum = false
  for(let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    const upper = code >= 65 && code <= 90
    const alnum = upper || code >= 97 && code <= 122 || code >= 48 && code <= 57
    const beginning = upper && !wasUpper || !wasAlnum || !alnum
    wasUpper = upper
    wasAlnum = alnum
    if(beginning) result.push(i)
  }
  return result
}
function reference(query, target) {
  if(effectiveEmpty(query)) {
    return {matched: true, raw: -Infinity, score: 0, indexes: []}
  }
  const result = fuzzysort.go(query, [target], {threshold: 0, limit: 0})[0]
  if(!result) return {matched: false, raw: null, score: null, indexes: []}
  return {
    matched: true,
    raw: result._score,
    score: result.score,
    indexes: result.indexes,
  }
}

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------
function hex(value) {
  return Buffer.from(value, 'utf8').toString('hex')
}
function unhex(value) {
  return Buffer.from(value, 'hex').toString('utf8')
}
function runCli(mode, lines, label) {
  const input = lines.length ? lines.join('\n') + '\n' : ''
  const result = spawnSync(cli, [mode], {
    input,
    maxBuffer: 1024 * 1024 * 1024,
    encoding: 'utf8',
  })
  if(result.error) throw result.error
  if(result.status !== 0) {
    throw new Error(`${mode} failed (${label}): ${result.stderr}`)
  }
  const output = result.stdout
  return output.length ? output.replace(/\n$/, '').split('\n') : []
}

function sameIndexes(a, b) {
  if(a.length !== b.length) return false
  for(let i = 0; i < a.length; i++) if(a[i] !== b[i]) return false
  return true
}
function close(a, b, absTol, relTol) {
  if(!Number.isFinite(a) || !Number.isFinite(b)) return a === b
  return Math.abs(a - b) <= absTol + relTol * Math.abs(b)
}

// ---------------------------------------------------------------------------
// Deterministic random cases
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  return function() {
    let t = seed += 0x6d2b79f5
    t = Math.imul(t ^ t >>> 15, t | 1)
    t ^= t + Math.imul(t ^ t >>> 7, t | 61)
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}
const rand = mulberry32(0x5eed1234)
function pick(array) { return array[Math.floor(rand() * array.length)] }
function randomString(maxLen = 60) {
  const alphabets = [
    'abcdefghijklmnopqrstuvwxyz',
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    '0123456789',
    ' -_./\\"\'`',
    'äöüéèêñçøłđıħŧ',
    'ÄÖÜÉÈÊÑÇØŁĐ',
    'αβγδεζηθικλμνξοπρστυφχψωΣΟΣ',
    '日本語テスト',
    '😀😁😂🤣😃😄😅😆',
    '[](){}<>:;,?!@#$%^&*+=~|',
  ]
  let result = ''
  const length = Math.floor(rand() * (maxLen + 1))
  for(let i = 0; i < length; i++) result += pick(Array.from(pick(alphabets)))
  return result
}
function mutate(value) {
  const choice = Math.floor(rand() * 8)
  const chars = Array.from(value)
  if(choice === 0) return value
  if(choice === 1) return chars.slice(0, Math.floor(rand() * (chars.length + 1))).join('')
  if(choice === 2) return chars.filter(() => rand() > .4).join('')
  if(choice === 3) return value.replace(/./gu, c => rand() > .5 ? c.toUpperCase() : c.toLowerCase())
  if(choice === 4) return value.split(' ').reverse().join(' ')
  if(choice === 5) return value.replace(/./gu, c => c + (rand() > .8 ? ' ' : ''))
  if(choice === 6) return chars.slice(Math.floor(rand() * chars.length)).join('')
  return Array.from({length: 1 + Math.floor(rand() * 3)}, () => pick(chars)).join('')
}

// ---------------------------------------------------------------------------
// Curated cases from fuzzysort's test suite plus known tricky inputs
// ---------------------------------------------------------------------------
const curated = []
function add(query, target, note = '') {
  curated.push({query, target, note})
}

add('', 'abc', 'empty query')
add('', '', 'empty query and target')
add(' ', 'abc', 'whitespace query')
add('  foo   foo  ', 'foo bar', 'duplicate terms')
add('abc', 'abc')
add('abc', 'acb', 'not a subsequence')
add('APPLES', 'app', 'curated')
add('APPLES', 'l', 'curated')
add('APPLES', 'E', 'curated')
add('APPLES', 'xxx', 'curated no match')
add('noodle monster', 'nomon', 'curated')
add('noodle monster', 'qrs', 'curated no match')
add('C:/users/farzher/dropbox/someotherfolder/pocket rumble refactor/Run.bat', 'po')
add('C:/users/farzher/dropbox/someotherfolder/pocket rumble refactor/Run.bat', 'po ru')
add('C:/users/farzher/dropbox/someotherfolder/pocket rumble refactor/Run.bat', 'pr')
add('C:/users/farzher/dropbox/someotherfolder/pocket rumble refactor/Run.bat', 'prrun')
add('C:/users/farzher/dropbox/someotherfolder/pocket rumble refactor/Run.bat', 'ocket umble')
add('123abc', '12')
add('123abc', '1')
add('123abc', 'a')
add('123abc', 'cc', 'curated no match')
add('Thoug ht', 'ht')
add('Thoug ht', 'hh', 'curated no match')
add('az bx cyy y', 'az')
add('az bx cyy y', 'ab')
add('az bx cyy y', 'ay')
add('az bx cyy y', 'ax')
add('az bx cyy y', 'ayy')
add('sax saxax', 'sx')
add('aabb b b b', 'abbbb')
add('aab x', 'ab')
add('aabb b', 'abb')
add('cman', 'CheatManager.h')
add('cman', 'CrowdManager.h')
add('c man', 'CheatManager.h')
add('man c', 'CheatManager.h')
add('man c', 'ThisManagesStuff.c')
add('c man', 'ThisCheatsStuff.man')
add('adio', 'Audio.h')
add('adio', 'AsyncTaskDownloadImage.h')
add('note', 'node/noTe')
add('note', 'not one that evening')
add('your mom', 'Seize your moment.')
add('your mom', 'Your mom goes to college.')
add('foo', 'x foo! end')
add('foo', 'x food end')
add('ab', 'x abC')
add('ab', 'x abc')
add('er.life360', 'device-tracker.life360_iphone_6')
add('er.life360', 'sendor.battery_life360_iphone_6')
add('this is exactly the same search and target', 'this is exactly the same search and target')
add('The Amazing Spider-Man', 'The Amazing Spider-Man')
add('The Amazing Spider-Man', 'The Amazing Spider')
add('The Amazing Spider-Man', 'The Amazing')
add('The Amazing Spider-Man', 'The')
add('a', 'ba')
add('a', 'bA')
add('a', 'a')
add('a', 'xx')
add('a', 'ba')
add('cat', 'basecategory cat')
add('pants on the ground', 'electron-uwp-background: Sample explaining how to use')
add('straw berry', 'strawberry')
add('Ääsma', 'Änni ÄÄsma')
add('aasma', 'Änni ÄÄsma')
add('cafe', 'Café Society')
add('o', 'ø')
add('ø', 'o')
add('"', '“')
add('“', '"')
add("'", '’')
add('/', '\\')
add('\\', '/')
add('.', '…')
add('…', '.')
add('+', '&')
add('.', ',')
add('x', '☃')
add('l', 'ł')
add('x', 'ł')
add('ジ', 'ファイナルファンタジーXIV スターターパック')
add('w', 'Rich JavaScript Applications – the Seven Frameworks (Throne of JS, 2012) - Steve Sanderson’s blog - As seen on YouTube™')
add('😀', 'grinning 😀 face')
add('ab', '😀🦊😀ab')
add('🙂', 'a🙂b')
add('abcdefghij', 'a b c d e f g h i j')
add('aaaaaaaaaaab', 'a a a a a a a a a a a a a a a a a a a a a a a a a a a a a a a xb')
add('prrun', 'C:/users/farzher/dropbox/someotherfolder/pocket rumble refactor/Run.bat')
add('pr run', 'C:/users/farzher/dropbox/someotherfolder/pocket rumble refactor/Run.bat')
add('pr run      e     e e e        e      e e ee         e     e', 'C:/users/farzher/dropbox/someotherfolder/pocket rumble refactor/Run.bat')
add('˚', 'team')
add('˚t', 'team')
add('˚tt', 'team')
add('´', 'anything')
add('¨', 'anything')
add('¸', 'anything')
add('¯', 'anything')
add('˚', 'anything')
add('ß', 'ẞ')
add('ẞ', 'ß')
add('σ', 'Σ')
add('ς', 'Σ')
add('ος', 'ΟΣ')
add('ΟΣ', 'ος')
add('İ', 'i')
add('i', 'İ')
add('ﬃ', 'ffi')
add('ffi', 'ﬃ')
add('½', '1⁄2')
add('²', '2')
add('２', '2')
add('ＡＢＣ', 'abc')
add('\u00a0abc\u00a0', 'abc')
add('\ufeffabc\ufeff', 'abc')
add('tab\tquery', 'tab query')
add('line\nquery', 'line query')

// Long / boundary targets
for(const n of [0, 1, 2, 3, 23, 24, 25, 64, 100, 999, 1000, 65534, 65535, 65536]) {
  const target = 'a'.repeat(n)
  add('a', target, `long target ${n}`)
  add('aa', target, `long target ${n}`)
  add('aaaa', target, `long target ${n}`)
  add('b', target, `long target ${n} no match`)
}
add('aaaa bbb', 'a'.repeat(65532) + 'bbb')
add('aaaa', 'a'.repeat(65535))

// Randomized score cases
const randomTargets = Array.from({length: 1500}, () => randomString(80))
for(let i = 0; i < 1500; i++) {
  const target = pick(randomTargets)
  const query = mutate(target)
  add(query, target, 'random')
}
for(let i = 0; i < 1500; i++) {
  const target = randomString(40)
  const query = randomString(12)
  add(query, target, 'random-independent')
}

// ---------------------------------------------------------------------------
// Dataset cases
// ---------------------------------------------------------------------------
function loadJson(name) {
  return JSON.parse(readFileSync(resolve(projectRoot, `../fuzzysort/test/${name}.json`), 'utf8'))
}
function addPairs(strings, queries, note, limit = Infinity) {
  const count = Math.min(strings.length, limit)
  for(let i = 0; i < count; i++) {
    const target = strings[i]
    if(typeof target !== 'string') continue
    for(const query of queries) add(query, target, note)
  }
}

const ue4 = loadJson('ue4_files')
addPairs(ue4, [
  'e', 'el', 'eld', 'render', 'rtrgt', 'mrender.h', 'nnnne', 'cman',
  'prrun', 'ui', 'audio', 'note', 'a', 'z', 'zzz', 'target.cs',
], 'ue4')

const steam = loadJson('steam_games')
const steamSample = []
for(let i = 0; i < 4000; i++) steamSample.push(steam[Math.floor(rand() * steam.length)])
addPairs(steamSample, ['e', 'el', 'eld', 'field', 'render', 'zzzz', 'a', 'the'], 'steam-sample')

const pokemon = loadJson('pokemon')
for(let i = 0; i < 1000; i++) {
  const p = pokemon[Math.floor(rand() * pokemon.length)]
  for(const field of ['name', 'desc', 'type']) {
    if(typeof p[field] === 'string') {
      add(p[field].slice(0, 20), p[field], 'pokemon')
      add('grass poison seed', p[field], 'pokemon-phrase')
    }
  }
}
const urls = loadJson('urls_and_titles')
for(const item of urls) {
  add('github react', item.title ?? '', 'urls-title')
  add('github react', item.url ?? '', 'urls-url')
  add('image video gif', item.title ?? '', 'urls-title')
  add('image video gif', item.url ?? '', 'urls-url')
}
const movie = loadJson('movie_quotes')
for(let i = 0; i < 500; i++) {
  const m = movie[Math.floor(rand() * movie.length)]
  add('never drink wine', m.quote ?? '', 'movie-quote')
  add('dracula', m.movie ?? '', 'movie-movie')
}
const emoji = loadJson('emoji')
for(const item of emoji) {
  add(item.char ?? '', item.name ?? '', 'emoji-char-vs-name')
  add('grin happy smile', item.search ?? '', 'emoji-search')
}

// ---------------------------------------------------------------------------
// Layer 1: normalization
// ---------------------------------------------------------------------------
function compareNormalization(mode, expectedFn, label) {
  const values = []
  for(let cu = 0; cu <= 0xffff; cu++) {
    if(cu >= 0xd800 && cu <= 0xdfff) continue
    values.push(String.fromCharCode(cu))
  }
  for(const item of curated) {
    values.push(mode === 'normalize-query' ? item.query : item.target)
  }
  for(const target of randomTargets) values.push(target)
  for(let i = 0; i < 300; i++) values.push(randomString(30))

  const unique = [...new Set(values)]
  const lines = unique.map(hex)
  const output = runCli(mode, lines, label)
  if(output.length !== unique.length)
    throw new Error(`${label}: expected ${unique.length} output lines, got ${output.length}`)

  let failures = 0
  for(let i = 0; i < unique.length; i++) {
    const expected = expectedFn(unique[i])
    const actual = unhex(output[i])
    if(actual !== expected) {
      if(failures < 20) {
        console.error(`NORMALIZE MISMATCH (${label})`)
        console.error(' input   ', JSON.stringify(unique[i]))
        console.error(' expected', JSON.stringify(expected))
        console.error(' actual  ', JSON.stringify(actual))
      }
      failures++
    }
  }
  console.log(`${label}: ${unique.length - failures}/${unique.length} passed`)
  return failures
}

// ---------------------------------------------------------------------------
// Layer 2: beginnings
// ---------------------------------------------------------------------------
function compareBeginnings() {
  const values = []
  for(let cu = 0; cu <= 0xffff; cu++) {
    if(cu >= 0xd800 && cu <= 0xdfff) continue
    values.push(String.fromCharCode(cu))
  }
  for(const item of curated) values.push(item.target)
  for(const target of randomTargets) values.push(target)
  for(let i = 0; i < 300; i++) values.push(randomString(60))

  const unique = [...new Set(values)]
  const output = runCli('beginnings', unique.map(hex), 'beginnings')
  let failures = 0
  for(let i = 0; i < unique.length; i++) {
    const expected = beginningsReference(unique[i])
    const actual = output[i] === '' ? [] : output[i].split(',').map(Number)
    if(!sameIndexes(actual, expected)) {
      if(failures < 20) {
        console.error('BEGINNINGS MISMATCH')
        console.error(' input   ', JSON.stringify(unique[i]))
        console.error(' expected', expected)
        console.error(' actual  ', actual)
      }
      failures++
    }
  }
  console.log(`beginnings: ${unique.length - failures}/${unique.length} passed`)
  return failures
}

// ---------------------------------------------------------------------------
// Layer 3: match/score/indexes
// ---------------------------------------------------------------------------
function compareScores(cases) {
  const lines = cases.map(c => hex(c.query) + '\t' + hex(c.target))
  const output = runCli('score', lines, 'score')
  if(output.length !== cases.length)
    throw new Error(`score: expected ${cases.length} output lines, got ${output.length}`)

  let failures = 0
  let matches = 0
  for(let i = 0; i < cases.length; i++) {
    const c = cases[i]
    const expected = reference(c.query, c.target)
    const fields = output[i].split('\t')
    const boolMatch = fields[0] === '1'
    const scoreMatch = fields[1] === '1'
    const actualRaw = fields[2] === '' ? null : Number(fields[2])
    const actualScore = fields[3] === '' ? null : Number(fields[3])
    const actualIndexes = fields[4] === '' ? [] : fields[4].split(',').map(Number)
    if(expected.matched) matches++

    let ok = boolMatch === expected.matched && scoreMatch === expected.matched
    if(ok && expected.matched) {
      ok = close(actualRaw, expected.raw, 1e-9, 1e-12) &&
           close(actualScore, expected.score, 1e-12, 1e-12) &&
           sameIndexes(actualIndexes, expected.indexes)
    }

    if(!ok) {
      if(failures < 25) {
        console.error('SCORE MISMATCH')
        console.error(' query   ', JSON.stringify(c.query))
        console.error(' target  ', JSON.stringify(c.target.slice(0, 300)))
        console.error(' note    ', c.note)
        console.error(' expected', expected)
        console.error(' actual  ', {
          boolMatch, scoreMatch, raw: actualRaw, score: actualScore,
          indexes: actualIndexes,
        })
      }
      failures++
    }
  }
  console.log(`score: ${cases.length - failures}/${cases.length} passed (${matches} matches)`)
  return failures
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
let failures = 0
console.log(`reference: fuzzysort 4.0.2 at ${referencePath}`)
console.log(`curated cases: ${curated.length}`)

failures += compareNormalization('normalize-query', normalizeQueryReference, 'query normalization')
failures += compareNormalization('normalize-target', normalizeTargetReference, 'target normalization')
failures += compareBeginnings()
failures += compareScores(curated)

if(failures) {
  console.error(`\nPHASE 1 PARITY FAILED: ${failures} mismatch(es)`)
  process.exitCode = 1
} else {
  console.log('\nPHASE 1 PARITY PASSED')
}
