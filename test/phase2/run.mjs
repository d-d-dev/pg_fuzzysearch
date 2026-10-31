#!/usr/bin/env node
/*
 * Phase 2 SQL-level parity test.
 *
 * Starts a temporary PostgreSQL 17 cluster, loads the extension SQL with an
 * absolute .so path (no system install required), loads fuzzysort-generated
 * cases, and verifies the SQL API against the reference.
 *
 * Run from the project root:
 *   make test-phase2
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '../..')
const referencePath = resolve(projectRoot, '../fuzzysort/fuzzysort.js')
const fuzzysort = (await import(new URL(`file://${referencePath}`))).default

const pgConfig = process.env.PG_CONFIG || 'pg_config'
const bindir = spawnSync(pgConfig, ['--bindir'], {encoding: 'utf8'}).stdout.trim()
const initdb = join(bindir, 'initdb')
const pgCtl = join(bindir, 'pg_ctl')
const psqlBin = join(bindir, 'psql')
const user = userInfo().username
const socketDir = '/tmp/opencode'
const port = process.env.PG_TEST_PORT || '55439'
const clusterDir = mkdtempSync(join(socketDir, 'pg_fuzzy_phase2_'))
const caseDir = mkdtempSync(join(tmpdir(), 'pg_fuzzy_phase2_cases_'))
const logFile = join(clusterDir, 'postgres.log')

let started = false

function fail(message, detail = '') {
  if(detail) console.error(detail)
  console.error(`FAIL: ${message}`)
  process.exitCode = 1
  throw new Error(message)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 1024,
    ...options,
  })
  if(result.error) throw result.error
  if(result.status !== 0) {
    if(options.allowFailure) return result
    throw new Error(`${command} ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  }
  return result
}

function psql(args, input) {
  return run(psqlBin, [
    '-h', socketDir, '-p', port, '-U', user, '-d', 'fuzzy_test',
    '-v', 'ON_ERROR_STOP=1', ...args,
  ], {input})
}

function startCluster() {
  rmSync(clusterDir, {recursive: true, force: true})
  run(initdb, ['-D', clusterDir, '-U', user, '--no-locale', '-E', 'UTF8'])
  const options = `-p ${port} -k ${socketDir} -c listen_addresses=''`
  run(pgCtl, ['-D', clusterDir, '-o', options, '-l', logFile, '-w', 'start'])
  started = true
  run(psqlBin, [
    '-h', socketDir, '-p', port, '-U', user, '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-c', 'CREATE DATABASE fuzzy_test;',
  ])
}

function stopCluster() {
  if(!started) return
  try {
    run(pgCtl, ['-D', clusterDir, '-m', 'immediate', '-w', 'stop'], {allowFailure: true})
  } finally {
    started = false
  }
}

// ---------------------------------------------------------------------------
// Reference normalization/scoring (same contract as Phase 1)
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
function reference(query, target) {
  if(effectiveEmpty(query)) return {matched: true, score: 0}
  const result = fuzzysort.go(query, [target], {threshold: 0, limit: 0})[0]
  if(!result) return {matched: false, score: null}
  return {matched: true, score: result.score}
}

function mulberry32(seed) {
  return function() {
    let t = seed += 0x6d2b79f5
    t = Math.imul(t ^ t >>> 15, t | 1)
    t ^= t + Math.imul(t ^ t >>> 7, t | 61)
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}
const rand = mulberry32(0xfa22cafe)
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

function loadJson(name) {
  return JSON.parse(readFileSync(resolve(projectRoot, `../fuzzysort/test/${name}.json`), 'utf8'))
}

const scoreCases = []
function add(query, target, note = '') {
  scoreCases.push({query, target, note})
}
add('', 'abc', 'empty query')
add('', '', 'empty query and target')
add(' ', 'abc', 'whitespace query')
add('  foo   foo  ', 'foo bar', 'duplicate terms')
add('abc', 'abc')
add('abc', 'acb', 'not a subsequence')
add('render', 'C:/Project/Renderer/RenderTarget.cpp')
add('rtrgt', 'C:/Project/Renderer/RenderTarget.cpp')
add('prrun', 'C:/users/farzher/dropbox/someotherfolder/pocket rumble refactor/Run.bat')
add('pr run', 'C:/users/farzher/dropbox/someotherfolder/pocket rumble refactor/Run.bat')
add('straw berry', 'strawberry')
add('cafe', 'Café Society')
add('Ääsma', 'Änni ÄÄsma')
add('aasma', 'Änni ÄÄsma')
add('ジ', 'ファイナルファンタジーXIV スターターパック')
add('😀', 'grinning 😀 face')
add('b', 'foobar baz')
add('the amazing', 'The Amazing Spider-Man')
add('c man', 'CheatManager.h')
add('man c', 'CheatManager.h')
add('man c', 'ThisManagesStuff.c')
add('c man', 'ThisCheatsStuff.man')
add('cat', 'basecategory cat')
add('pants on the ground', 'electron-uwp-background: Sample explaining how to use')
add('"', '“')
add('/', '\\')
add('.', '…')
add('+', '&')
add('l', 'ł')
add('x', 'ł')
add('ß', 'ẞ')
add('σ', 'Σ')
add('ος', 'ΟΣ')
add('İ', 'i')
add('ﬃ', 'ffi')
add('²', '2')
add('ＡＢＣ', 'abc')
add('tab\tquery', 'tab query')
add('line\nquery', 'line query')
add('˚', 'team')
add('˚t', 'team')
add('˚tt', 'team')
add('a', 'a'.repeat(60000))
add('aaaa', 'a'.repeat(60000))
add('xxxx', 'a'.repeat(60000))
add('aaaa bbb', 'a'.repeat(60000) + 'bbb')
add('zzzzzzzzzzzzzzzz', 'a '.repeat(20000))

const randomTargets = Array.from({length: 1200}, () => randomString(80))
for(let i = 0; i < 1200; i++) {
  const target = pick(randomTargets)
  const chars = Array.from(target)
  const queries = [
    target,
    chars.filter(() => rand() > .4).join(''),
    chars.slice(0, Math.floor(rand() * (chars.length + 1))).join(''),
    Array.from({length: 1 + Math.floor(rand() * 4)}, () => pick(chars)).join(''),
  ]
  add(pick(queries), target, 'random')
}
for(let i = 0; i < 1200; i++) add(randomString(12), randomString(40), 'random-independent')

const ue4 = loadJson('ue4_files')
for(let i = 0; i < 1500; i++) {
  const target = ue4[Math.floor(rand() * ue4.length)]
  add(pick(['e', 'el', 'eld', 'render', 'rtrgt', 'mrender.h', 'cman', 'a', 'zzz']), target, 'ue4')
}
const steam = loadJson('steam_games')
for(let i = 0; i < 1000; i++) {
  const target = steam[Math.floor(rand() * steam.length)]
  add(pick(['e', 'el', 'eld', 'field', 'render', 'a', 'zzzz']), target, 'steam')
}
const pokemon = loadJson('pokemon')
for(let i = 0; i < 500; i++) {
  const p = pokemon[Math.floor(rand() * pokemon.length)]
  for(const field of ['name', 'desc', 'type']) {
    if(typeof p[field] === 'string') add(p[field].slice(0, 20), p[field], 'pokemon')
  }
}
const emoji = loadJson('emoji')
for(let i = 0; i < 500; i++) {
  const item = emoji[Math.floor(rand() * emoji.length)]
  add(item.char ?? '', item.name ?? '', 'emoji')
  add('grin happy smile', item.search ?? '', 'emoji-search')
}

// ---------------------------------------------------------------------------
// CSV helpers and file generation
// ---------------------------------------------------------------------------
function csvField(value) {
  return '"' + value.replace(/"/g, '""') + '"'
}
function csvLine(fields) {
  return fields.map(field => field === null ? '' : csvField(String(field))).join(',')
}

function generateScoreCases() {
  const lines = []
  for(const c of scoreCases) {
    const expected = reference(c.query, c.target)
    const threshold = expected.score !== null && expected.score >= 0.5
    lines.push(csvLine([
      c.query,
      c.target,
      expected.matched ? 't' : 'f',
      expected.score === null ? null : expected.score.toPrecision(17),
      threshold ? 't' : 'f',
      normalizeQueryReference(c.query),
      normalizeTargetReference(c.target),
    ]))
  }
  const file = join(caseDir, 'score.csv')
  writeFileSync(file, lines.join('\n') + '\n')
  return file
}

function generateNormalizationCases() {
  const lines = []
  for(let cu = 0; cu <= 0xffff; cu++) {
    if(cu === 0) continue
    if(cu >= 0xd800 && cu <= 0xdfff) continue
    const value = String.fromCharCode(cu)
    lines.push(csvLine([
      value,
      normalizeQueryReference(value),
      normalizeTargetReference(value),
    ]))
  }
  const file = join(caseDir, 'normalize.csv')
  writeFileSync(file, lines.join('\n') + '\n')
  return file
}

// ---------------------------------------------------------------------------
// SQL setup and checks
// ---------------------------------------------------------------------------
function loadFunctions() {
  const sql = readFileSync(resolve(projectRoot, 'sql/pg_fuzzysearch--0.2.0.sql'), 'utf8')
    .replaceAll('MODULE_PATHNAME', resolve(projectRoot, 'pg/pg_fuzzysearch.so'))
    .split('\n')
    .filter(line => !line.startsWith('\\echo'))
    .join('\n')
  psql(['-f', '-'], sql)
}

function loadCsv(file, table, columns) {
  psql(['-c', `\\copy ${table} (${columns}) FROM '${file}' WITH (FORMAT csv)`])
}

function checkScoreCases(file) {
  psql(['-c', `
    CREATE TABLE score_cases (
      query text,
      target text,
      expected_match boolean,
      expected_score double precision,
      expected_threshold boolean,
      expected_norm_query text,
      expected_norm_target text
    );
  `])
  loadCsv(file, 'score_cases',
    'query,target,expected_match,expected_score,expected_threshold,expected_norm_query,expected_norm_target')

  const result = psql(['-Atc', `
    WITH actual AS MATERIALIZED (
      SELECT c.*,
             fuzzy_match(query, target) AS actual_match,
             fuzzy_score(query, target) AS actual_score,
             fuzzy_match(query, target, 0.1) AS t01,
             fuzzy_match(query, target, 0.3) AS t03,
             fuzzy_match(query, target, 0.5) AS actual_threshold,
             fuzzy_match(query, target, 0.8) AS t08,
             fuzzy_match(query, target, 1.0) AS t10,
             fuzzy_normalize_query(query) AS actual_norm_query,
             fuzzy_normalize(target) AS actual_norm_target
      FROM score_cases c
    )
    SELECT
      count(*) FILTER (WHERE actual_match IS DISTINCT FROM expected_match),
      count(*) FILTER (WHERE actual_threshold IS DISTINCT FROM expected_threshold),
      count(*) FILTER (WHERE
        (expected_score IS NULL) <> (actual_score IS NULL)
        OR (expected_score IS NOT NULL AND abs(actual_score - expected_score) > 1e-12)),
      count(*) FILTER (WHERE
        t01 IS DISTINCT FROM (expected_score IS NOT NULL AND expected_score >= 0.1)
        OR t03 IS DISTINCT FROM (expected_score IS NOT NULL AND expected_score >= 0.3)
        OR t08 IS DISTINCT FROM (expected_score IS NOT NULL AND expected_score >= 0.8)
        OR t10 IS DISTINCT FROM (expected_score IS NOT NULL AND expected_score >= 1.0)),
      count(*) FILTER (WHERE actual_norm_query IS DISTINCT FROM expected_norm_query),
      count(*) FILTER (WHERE actual_norm_target IS DISTINCT FROM expected_norm_target),
      count(*)
    FROM actual;
  `])
  const [badMatch, badThreshold, badScore, badMoreThresholds, badNq, badNt, total] =
    result.stdout.trim().split('|').map(Number)
  console.log(`score cases: ${total - Math.max(badMatch, badThreshold, badMoreThresholds, badScore, badNq, badNt)}/${total} passed`)
  if(badMatch || badThreshold || badMoreThresholds || badScore || badNq || badNt) {
    const bad = psql(['-Atc', `
      WITH actual AS MATERIALIZED (
        SELECT c.*,
               fuzzy_match(query, target) AS actual_match,
               fuzzy_score(query, target) AS actual_score,
               fuzzy_match(query, target, 0.1) AS t01,
               fuzzy_match(query, target, 0.3) AS t03,
               fuzzy_match(query, target, 0.5) AS actual_threshold,
               fuzzy_match(query, target, 0.8) AS t08,
               fuzzy_match(query, target, 1.0) AS t10,
               fuzzy_normalize_query(query) AS actual_norm_query,
               fuzzy_normalize(target) AS actual_norm_target
        FROM score_cases c
      )
      SELECT query, left(target, 120), expected_match, actual_match, expected_score,
             actual_score, expected_threshold, actual_threshold,
             t01, t03, t08, t10
      FROM actual
      WHERE actual_match IS DISTINCT FROM expected_match
         OR actual_threshold IS DISTINCT FROM expected_threshold
         OR t01 IS DISTINCT FROM (expected_score IS NOT NULL AND expected_score >= 0.1)
         OR t03 IS DISTINCT FROM (expected_score IS NOT NULL AND expected_score >= 0.3)
         OR t08 IS DISTINCT FROM (expected_score IS NOT NULL AND expected_score >= 0.8)
         OR t10 IS DISTINCT FROM (expected_score IS NOT NULL AND expected_score >= 1.0)
         OR (expected_score IS NULL) <> (actual_score IS NULL)
         OR (expected_score IS NOT NULL AND abs(actual_score - expected_score) > 1e-12)
         OR actual_norm_query IS DISTINCT FROM expected_norm_query
         OR actual_norm_target IS DISTINCT FROM expected_norm_target
      LIMIT 20;
    `])
    fail(`score-case mismatches: match=${badMatch}, threshold=${badThreshold}, more_thresholds=${badMoreThresholds}, score=${badScore}, norm_query=${badNq}, norm_target=${badNt}`,
         bad.stdout)
  }
}

function checkNormalizationCases(file) {
  psql(['-c', 'CREATE TABLE normalize_cases (value text, expected_query text, expected_target text);'])
  loadCsv(file, 'normalize_cases', 'value,expected_query,expected_target')
  const result = psql(['-Atc', `
    WITH actual AS MATERIALIZED (
      SELECT value, expected_query, expected_target,
             fuzzy_normalize_query(value) AS actual_query,
             fuzzy_normalize(value) AS actual_target
      FROM normalize_cases
    )
    SELECT
      count(*) FILTER (WHERE actual_query IS DISTINCT FROM expected_query),
      count(*) FILTER (WHERE actual_target IS DISTINCT FROM expected_target),
      count(*)
    FROM actual;
  `])
  const [badQuery, badTarget, total] = result.stdout.trim().split('|').map(Number)
  console.log(`normalization cases: ${total - Math.max(badQuery, badTarget)}/${total} passed`)
  if(badQuery || badTarget) {
    const bad = psql(['-Atc', `
      WITH actual AS MATERIALIZED (
        SELECT value, expected_query, expected_target,
               fuzzy_normalize_query(value) AS actual_query,
               fuzzy_normalize(value) AS actual_target
        FROM normalize_cases
      )
      SELECT value, expected_query, actual_query, expected_target, actual_target
      FROM actual
      WHERE actual_query IS DISTINCT FROM expected_query
         OR actual_target IS DISTINCT FROM expected_target
      LIMIT 20;
    `])
    fail(`normalization mismatches: query=${badQuery}, target=${badTarget}`, bad.stdout)
  }
}

function checkApi() {
  const result = psql(['-Atc', `
    SELECT bool_and(ok) FROM (VALUES
      (fuzzy_match(NULL, 'x') IS NULL),
      (fuzzy_score('x', NULL) IS NULL),
      (fuzzy_match('', 'abc')),
      (fuzzy_score('', 'abc') = 0),
      (fuzzy_match('', 'abc', 0.5) = false),
      (fuzzy_match('', 'abc', 0.0)),
      (fuzzy_match('   ', 'abc')),
      (fuzzy_score('   ', 'abc') = 0),
      (fuzzy_match('a', '') = false),
      (fuzzy_score('a', '') IS NULL),
      (fuzzy_match('abc', 'abc', 1.0)),
      (fuzzy_match('abc', 'abc', 1.1) = false),
      (fuzzy_match('abc', 'abc', -1.0))
    ) v(ok);
  `])
  if(result.stdout.trim() !== 't')
    fail('basic SQL API assertions failed', result.stdout)

  const parallel = psql(['-Atc', `
    SELECT bool_and(proparallel = 's' AND provolatile = 'i' AND proisstrict)
    FROM pg_proc
    WHERE proname IN ('fuzzy_match', 'fuzzy_score', 'fuzzy_normalize', 'fuzzy_normalize_query');
  `])
  if(parallel.stdout.trim() !== 't')
    fail('functions are not all STRICT/IMMUTABLE/PARALLEL SAFE', parallel.stdout)

  // Changing query text on every row exercises fn_extra cache invalidation.
  const varying = psql(['-Atc', `
    SELECT count(*) FROM (VALUES
      ('render', 'C:/Project/Renderer/RenderTarget.cpp', 0.77580865038397195::float8),
      ('rtrgt',  'C:/Project/Renderer/RenderTarget.cpp', 0.24674754317189815::float8),
      ('zzz',    'C:/Project/Renderer/RenderTarget.cpp', NULL::float8)
    ) v(q, t, expected)
    WHERE (fuzzy_score(q, t) IS DISTINCT FROM expected)
       OR (abs(fuzzy_score(q, t) - expected) > 1e-12);
  `])
  if(varying.stdout.trim() !== '0')
    fail('fn_extra query cache invalidation failed', varying.stdout)

  // Prepared statements re-use the same FmgrInfo across executions.
  const prepared = psql(['-Atc', `
    PREPARE fuzzy_p(text, text) AS SELECT fuzzy_score($1, $2);
    EXECUTE fuzzy_p('render', 'C:/Project/Renderer/RenderTarget.cpp');
    EXECUTE fuzzy_p('zzz',    'C:/Project/Renderer/RenderTarget.cpp');
    EXECUTE fuzzy_p('rtrgt',  'C:/Project/Renderer/RenderTarget.cpp');
    EXECUTE fuzzy_p('render', 'C:/Project/Renderer/RenderTarget.cpp');
  `])
  const preparedLines = prepared.stdout.trim().split('\n')
    .filter(line => line !== 'PREPARE' && line !== 'EXECUTE')
  const expectedPrepared = ['0.77580865038397195', '', '0.24674754317189815', '0.77580865038397195']
  if(preparedLines.length !== expectedPrepared.length)
    fail('prepared-statement row count changed', prepared.stdout)
  for(let i = 0; i < expectedPrepared.length; i++) {
    if(expectedPrepared[i] === '') {
      if(preparedLines[i] !== '') fail('prepared no-match row was not NULL', prepared.stdout)
    } else if(Math.abs(Number(preparedLines[i]) - Number(expectedPrepared[i])) > 1e-12) {
      fail('prepared-statement query cache failed', prepared.stdout)
    }
  }

  console.log('basic SQL API: passed')
}

function checkNonUtf8Rejected() {
  run(psqlBin, [
    '-h', socketDir, '-p', port, '-U', user, '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-c',
    "CREATE DATABASE fuzzy_latin1 ENCODING 'LATIN1' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0;",
  ])
  const sql = readFileSync(resolve(projectRoot, 'sql/pg_fuzzysearch--0.2.0.sql'), 'utf8')
    .replaceAll('MODULE_PATHNAME', resolve(projectRoot, 'pg/pg_fuzzysearch.so'))
    .split('\n')
    .filter(line => !line.startsWith('\\echo'))
    .join('\n')
  run(psqlBin, [
    '-h', socketDir, '-p', port, '-U', user, '-d', 'fuzzy_latin1',
    '-v', 'ON_ERROR_STOP=1', '-f', '-',
  ], {input: sql})
  const result = run(psqlBin, [
    '-h', socketDir, '-p', port, '-U', user, '-d', 'fuzzy_latin1',
    '-v', 'ON_ERROR_STOP=1', '-c', "SELECT fuzzy_match('a', 'a');",
  ], {allowFailure: true})
  if(result.status === 0 || !result.stderr.includes('requires a UTF-8 database'))
    fail('non-UTF-8 database was not rejected', result.stderr)
  console.log('non-UTF-8 rejection: passed')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
try {
  startCluster()
  loadFunctions()
  checkApi()
  const scoreFile = generateScoreCases()
  const normalizeFile = generateNormalizationCases()
  checkScoreCases(scoreFile)
  checkNormalizationCases(normalizeFile)
  checkNonUtf8Rejected()
  console.log('\nPHASE 2 SQL PARITY PASSED')
} catch(error) {
  console.error(error.message)
  if(started) console.error(`cluster log: ${logFile}`)
  process.exitCode = 1
} finally {
  stopCluster()
  if(!process.exitCode) {
    rmSync(clusterDir, {recursive: true, force: true})
    rmSync(caseDir, {recursive: true, force: true})
  }
}
