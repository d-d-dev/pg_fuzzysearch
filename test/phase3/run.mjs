#!/usr/bin/env node
/*
 * Phase 3 correctness/parity test for prepared fuzzy_target values.
 *
 * Starts a temporary PostgreSQL 17 cluster, loads the 0.2.0 SQL, and verifies:
 *   - generated prepared columns
 *   - raw vs prepared score/match equality
 *   - text I/O round-trips
 *   - binary COPY round-trips
 *   - corrupt input rejection
 *   - empty/unicode/long prepared targets
 *   - the 0.1.0 -> 0.2.0 upgrade script
 *
 * Run from the project root:
 *   make test-phase3
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import { tmpdir, userInfo } from 'node:os'

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
const port = process.env.PG_TEST_PORT || '55443'
const clusterDir = mkdtempSync(join(socketDir, 'pg_fuzzy_phase3_'))
const caseDir = mkdtempSync(join(tmpdir(), 'pg_fuzzy_phase3_cases_'))
const logFile = join(clusterDir, 'postgres.log')
const dbs = ['fuzzy_test', 'fuzzy_upgrade']

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

function psql(args, input, db = 'fuzzy_test') {
  return run(psqlBin, [
    '-h', socketDir, '-p', port, '-U', user, '-d', db,
    '-v', 'ON_ERROR_STOP=1', ...args,
  ], {input})
}

function startCluster() {
  rmSync(clusterDir, {recursive: true, force: true})
  run(initdb, ['-D', clusterDir, '-U', user, '--no-locale', '-E', 'UTF8'])
  const options = `-p ${port} -k ${socketDir} -c listen_addresses=''`
  run(pgCtl, ['-D', clusterDir, '-o', options, '-l', logFile, '-w', 'start'])
  started = true
  for(const db of dbs) {
    run(psqlBin, [
      '-h', socketDir, '-p', port, '-U', user, '-d', 'postgres',
      '-v', 'ON_ERROR_STOP=1', '-c', `CREATE DATABASE ${db};`,
    ])
  }
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
// Reference normalization/scoring
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
const rand = mulberry32(0x3a5e1234)
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

const cases = []
function add(query, target) { cases.push({query, target}) }
add('', 'abc')
add(' ', 'abc')
add('abc', 'abc')
add('abc', 'acb')
add('render', 'C:/Project/Renderer/RenderTarget.cpp')
add('rtrgt', 'C:/Project/Renderer/RenderTarget.cpp')
add('prrun', 'C:/users/farzher/dropbox/someotherfolder/pocket rumble refactor/Run.bat')
add('straw berry', 'strawberry')
add('cafe', 'Café Society')
add('Ääsma', 'Änni ÄÄsma')
add('ジ', 'ファイナルファンタジーXIV スターターパック')
add('😀', 'grinning 😀 face')
add('the amazing', 'The Amazing Spider-Man')
add('c man', 'CheatManager.h')
add('man c', 'CheatManager.h')
add('"', '“')
add('/', '\\')
add('.', '…')
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
add('a', 'a'.repeat(60000))
add('aaaa', 'a'.repeat(60000))
add('xxxx', 'a'.repeat(60000))
add('aaaa bbb', 'a'.repeat(60000) + 'bbb')
add('zzzzzzzzzzzzzzzz', 'a '.repeat(20000))

const randomTargets = Array.from({length: 800}, () => randomString(80))
for(let i = 0; i < 800; i++) {
  const target = pick(randomTargets)
  const chars = Array.from(target)
  add(pick([
    target,
    chars.filter(() => rand() > .4).join(''),
    chars.slice(0, Math.floor(rand() * (chars.length + 1))).join(''),
    Array.from({length: 1 + Math.floor(rand() * 4)}, () => pick(chars)).join(''),
  ]), target)
}
for(let i = 0; i < 600; i++) add(randomString(12), randomString(40))

const ue4 = loadJson('ue4_files')
for(let i = 0; i < 700; i++) {
  add(pick(['e', 'el', 'eld', 'render', 'rtrgt', 'cman', 'a', 'zzz']),
      ue4[Math.floor(rand() * ue4.length)])
}
const steam = loadJson('steam_games')
for(let i = 0; i < 400; i++) {
  add(pick(['e', 'el', 'eld', 'field', 'render', 'a', 'zzzz']),
      steam[Math.floor(rand() * steam.length)])
}
const emoji = loadJson('emoji')
for(let i = 0; i < 200; i++) {
  const item = emoji[Math.floor(rand() * emoji.length)]
  add(item.char ?? '', item.name ?? '')
}

// ---------------------------------------------------------------------------
// CSV / SQL helpers
// ---------------------------------------------------------------------------
function csvField(value) {
  return '"' + value.replace(/"/g, '""') + '"'
}

/*
 * Build a version-1 fuzzy_target payload for an ASCII target.  Version 1 is
 * the layout written by the Phase 3 build; keeping a fixture here prevents
 * accidental breakage for values prepared before the compact v2 format.
 */
function v1PayloadHex(target) {
  const codes = [...target].map(c => c.charCodeAt(0))
  const beginnings = [0]
  const firstTable = new Array(26).fill(0)
  let bitflags = 0
  for(let i = 0; i < target.length; i++) {
    const c = target.charCodeAt(i)
    if(c === 32) bitflags |= 1 << 27
    else if(c >= 97 && c <= 122) bitflags |= 1 << (c - 97)
    else if(c >= 48 && c <= 57) bitflags |= 1 << 26
    else if(c <= 127) bitflags |= 1 << 30
    else bitflags |= 1 << 31
  }
  if(codes.length > 0 && codes[0] >= 97 && codes[0] <= 122)
    firstTable[codes[0] - 97] = 1

  const header = 128
  const payload = Buffer.alloc(header + 4 * beginnings.length + 2 * codes.length)
  payload.writeUInt32LE(0x465A5431, 0)
  payload.writeUInt32LE(1, 4)
  payload.writeUInt32LE(bitflags >>> 0, 8)
  payload.writeUInt32LE(0, 12)
  payload.writeInt32LE(codes.length, 16)
  payload.writeInt32LE(beginnings.length, 20)
  for(let i = 0; i < 26; i++) payload.writeInt32LE(firstTable[i], 24 + i * 4)
  let offset = header
  for(const value of beginnings) { payload.writeInt32LE(value, offset); offset += 4 }
  for(const value of codes) { payload.writeUInt16LE(value, offset); offset += 2 }
  return 'FX1:' + payload.toString('hex')
}
function csvLine(fields) {
  return fields.map(field => field === null ? '' : csvField(String(field))).join(',')
}
function scoreCaseFile() {
  const lines = []
  for(const c of cases) {
    const expected = reference(c.query, c.target)
    lines.push(csvLine([
      c.query, c.target,
      expected.matched ? 't' : 'f',
      expected.score === null ? null : expected.score.toPrecision(17),
    ]))
  }
  const file = join(caseDir, 'score.csv')
  writeFileSync(file, lines.join('\n') + '\n')
  return file
}
function loadSqlFile(db, file, replaceModule = true) {
  let sql = readFileSync(resolve(projectRoot, file), 'utf8')
  if(replaceModule) {
    sql = sql.replaceAll('MODULE_PATHNAME', resolve(projectRoot, 'pg/pg_fuzzysearch.so'))
  }
  sql = sql.split('\n').filter(line => !line.startsWith('\\echo')).join('\n')
  psql(['-f', '-'], sql, db)
}

function loadFunctions(db = 'fuzzy_test') {
  loadSqlFile(db, 'sql/pg_fuzzysearch--0.2.0.sql')
}

function checkPreparedCases(file) {
  psql(['-c', `
    CREATE TABLE score_cases (
      query text,
      target text,
      expected_match boolean,
      expected_score double precision,
      prepared fuzzy_target GENERATED ALWAYS AS (fuzzy_prepare(target)) STORED
    );
  `])
  psql(['-c', `\\copy score_cases (query, target, expected_match, expected_score) FROM '${file}' WITH (FORMAT csv)`])

  const result = psql(['-Atc', `
    WITH actual AS MATERIALIZED (
      SELECT c.*,
             fuzzy_match(query, target) AS raw_match,
             fuzzy_score(query, target) AS raw_score,
             fuzzy_match(query, prepared) AS prep_match,
             fuzzy_score(query, prepared) AS prep_score,
             fuzzy_match(query, prepared, 0.5) AS prep_threshold,
             fuzzy_score(query, (prepared::text)::fuzzy_target) AS roundtrip_score
      FROM score_cases c
    )
    SELECT
      count(*) FILTER (WHERE raw_match IS DISTINCT FROM expected_match),
      count(*) FILTER (WHERE
        (expected_score IS NULL) <> (raw_score IS NULL)
        OR (expected_score IS NOT NULL AND abs(raw_score - expected_score) > 1e-12)),
      count(*) FILTER (WHERE prep_match IS DISTINCT FROM raw_match),
      count(*) FILTER (WHERE
        (prep_score IS NULL) <> (raw_score IS NULL)
        OR (prep_score IS NOT NULL AND abs(prep_score - raw_score) > 1e-12)),
      count(*) FILTER (WHERE prep_threshold IS DISTINCT FROM
        (expected_score IS NOT NULL AND expected_score >= 0.5)),
      count(*) FILTER (WHERE
        (roundtrip_score IS NULL) <> (prep_score IS NULL)
        OR (roundtrip_score IS NOT NULL AND abs(roundtrip_score - prep_score) > 1e-12)),
      count(*)
    FROM actual;
  `])
  const [badRawMatch, badRawScore, badPrepMatch, badPrepScore,
         badThreshold, badRoundtrip, total] =
    result.stdout.trim().split('|').map(Number)
  const bad = Math.max(badRawMatch, badRawScore, badPrepMatch, badPrepScore,
                       badThreshold, badRoundtrip)
  console.log(`prepared cases: ${total - bad}/${total} passed`)
  if(bad) {
    const detail = psql(['-Atc', `
      WITH actual AS MATERIALIZED (
        SELECT c.*,
               fuzzy_match(query, target) AS raw_match,
               fuzzy_score(query, target) AS raw_score,
               fuzzy_match(query, prepared) AS prep_match,
               fuzzy_score(query, prepared) AS prep_score,
               fuzzy_match(query, prepared, 0.5) AS prep_threshold,
               fuzzy_score(query, (prepared::text)::fuzzy_target) AS roundtrip_score
        FROM score_cases c
      )
      SELECT query, left(target, 120), expected_score, raw_score, prep_score,
             roundtrip_score, expected_match, raw_match, prep_match, prep_threshold
      FROM actual
      WHERE raw_match IS DISTINCT FROM expected_match
         OR (expected_score IS NULL) <> (raw_score IS NULL)
         OR (expected_score IS NOT NULL AND abs(raw_score - expected_score) > 1e-12)
         OR prep_match IS DISTINCT FROM raw_match
         OR (prep_score IS NULL) <> (raw_score IS NULL)
         OR (prep_score IS NOT NULL AND abs(prep_score - raw_score) > 1e-12)
         OR prep_threshold IS DISTINCT FROM (expected_score IS NOT NULL AND expected_score >= 0.5)
         OR (roundtrip_score IS NULL) <> (prep_score IS NULL)
         OR (roundtrip_score IS NOT NULL AND abs(roundtrip_score - prep_score) > 1e-12)
      LIMIT 20;
    `])
    fail(`prepared mismatches: raw_match=${badRawMatch}, raw_score=${badRawScore}, prep_match=${badPrepMatch}, prep_score=${badPrepScore}, threshold=${badThreshold}, roundtrip=${badRoundtrip}`,
         detail.stdout)
  }
}

function checkTypeAndIo() {
  const v1 = v1PayloadHex('abc')
  const v1Result = psql(['-Atc', `
    SELECT fuzzy_score('abc', '${v1}'::fuzzy_target) = 1,
           fuzzy_match('abc', '${v1}'::fuzzy_target);
  `])
  if(v1Result.stdout.trim() !== 't|t')
    fail('version 1 prepared payload is not readable', v1Result.stdout)

  const typeProps = psql(['-Atc', `
    SELECT typlen = -1 AND typstorage = 'x' AND typalign = 'i'
    FROM pg_type WHERE oid = 'fuzzy_target'::regtype;
  `])
  if(typeProps.stdout.trim() !== 't')
    fail('fuzzy_target type storage/alignment properties changed', typeProps.stdout)

  const api = psql(['-Atc', `
    SELECT bool_and(ok) FROM (VALUES
      (fuzzy_match('', fuzzy_prepare('abc'))),
      (fuzzy_score('', fuzzy_prepare('abc')) = 0),
      (fuzzy_match('', fuzzy_prepare('abc'), 0.5) = false),
      (fuzzy_match('a', fuzzy_prepare('') ) = false),
      (fuzzy_score('a', fuzzy_prepare('') ) IS NULL),
      (fuzzy_match('cafe', fuzzy_prepare('Café Society'))),
      (fuzzy_match('render', fuzzy_prepare('C:/Project/Renderer/RenderTarget.cpp'), 0.5)),
      (fuzzy_score('zzz', fuzzy_prepare('abc')) IS NULL),
      ((fuzzy_prepare('abc')::text) LIKE 'FX1:%')
    ) v(ok);
  `])
  if(api.stdout.trim() !== 't')
    fail('prepared-target basic API assertions failed', api.stdout)

  const funcs = psql(['-Atc', `
    SELECT bool_and(proparallel = 's' AND provolatile = 'i' AND proisstrict)
    FROM pg_proc
    WHERE proname IN ('fuzzy_prepare', 'fuzzy_match', 'fuzzy_score');
  `])
  if(funcs.stdout.trim() !== 't')
    fail('prepared functions are not all STRICT/IMMUTABLE/PARALLEL SAFE', funcs.stdout)

  // Text output -> input round-trip.
  const textIo = psql(['-Atc', `
    SELECT count(*) FROM (
      VALUES
        ('C:/Project/Renderer/RenderTarget.cpp'),
        ('Café Society'),
        ('😀🦊 emoji'),
        (repeat('ab', 1000))
    ) v(target)
    WHERE fuzzy_score('render', (fuzzy_prepare(target)::text)::fuzzy_target)
          IS DISTINCT FROM fuzzy_score('render', fuzzy_prepare(target));
  `])
  if(textIo.stdout.trim() !== '0')
    fail('text I/O round-trip changed prepared scores', textIo.stdout)

  const corrupt1 = run(psqlBin, [
    '-h', socketDir, '-p', port, '-U', user, '-d', 'fuzzy_test',
    '-v', 'ON_ERROR_STOP=1', '-c', "SELECT 'FX1:00'::fuzzy_target;",
  ], {allowFailure: true})
  if(corrupt1.status === 0 || !corrupt1.stderr.includes('invalid fuzzy_target'))
    fail('corrupt FX1 payload was not rejected', corrupt1.stderr)

  const corrupt2 = run(psqlBin, [
    '-h', socketDir, '-p', port, '-U', user, '-d', 'fuzzy_test',
    '-v', 'ON_ERROR_STOP=1', '-c', "SELECT 'garbage'::fuzzy_target;",
  ], {allowFailure: true})
  if(corrupt2.status === 0 || !corrupt2.stderr.includes('invalid'))
    fail('invalid input syntax was not rejected', corrupt2.stderr)

  console.log('type I/O and API: passed')
}

function checkBinaryCopy() {
  const binFile = join(caseDir, 'prepared.bin')
  psql(['-f', '-'], `
    CREATE TABLE bin_src (id int, p fuzzy_target);
    INSERT INTO bin_src VALUES
      (1, fuzzy_prepare('C:/Project/Renderer/RenderTarget.cpp')),
      (2, fuzzy_prepare('Café Society')),
      (3, fuzzy_prepare('😀 emoji')),
      (4, fuzzy_prepare(''));
    \\copy bin_src TO '${binFile}' WITH (FORMAT binary)
    CREATE TABLE bin_dst (id int, p fuzzy_target);
    \\copy bin_dst FROM '${binFile}' WITH (FORMAT binary)
    SELECT count(*) FROM bin_src s JOIN bin_dst d USING (id)
    WHERE fuzzy_score('render', s.p) IS DISTINCT FROM fuzzy_score('render', d.p)
       OR fuzzy_score('cafe', s.p) IS DISTINCT FROM fuzzy_score('cafe', d.p);
  `)
  const count = psql(['-Atc', `
    SELECT count(*) FROM bin_src s JOIN bin_dst d USING (id)
    WHERE fuzzy_score('render', s.p) IS DISTINCT FROM fuzzy_score('render', d.p)
       OR fuzzy_score('cafe', s.p) IS DISTINCT FROM fuzzy_score('cafe', d.p)
       OR fuzzy_score('😀', s.p) IS DISTINCT FROM fuzzy_score('😀', d.p);
  `])
  if(count.stdout.trim() !== '0')
    fail('binary COPY round-trip changed prepared scores', count.stdout)
  console.log('binary COPY round-trip: passed')
}

function checkGeneratedColumn() {
  psql(['-f', '-'], `
    CREATE TABLE generated_test (
      id int,
      title text,
      title_fuzzy fuzzy_target GENERATED ALWAYS AS (fuzzy_prepare(title)) STORED
    );
    INSERT INTO generated_test (id, title) VALUES
      (1, 'C:/Project/Renderer/RenderTarget.cpp'),
      (2, 'Café Society'),
      (3, 'not a match');
    UPDATE generated_test SET title = 'new render title' WHERE id = 3;
  `)
  const result = psql(['-Atc', `
    SELECT count(*) FROM generated_test
    WHERE fuzzy_match('render', title_fuzzy) IS DISTINCT FROM fuzzy_match('render', title)
       OR fuzzy_score('render', title_fuzzy) IS DISTINCT FROM fuzzy_score('render', title)
       OR fuzzy_match('cafe', title_fuzzy) IS DISTINCT FROM fuzzy_match('cafe', title)
       OR fuzzy_score('cafe', title_fuzzy) IS DISTINCT FROM fuzzy_score('cafe', title);
  `])
  if(result.stdout.trim() !== '0')
    fail('generated prepared column differs from raw title', result.stdout)

  const updated = psql(['-Atc', `
    SELECT fuzzy_score('new render', title_fuzzy) = fuzzy_score('new render', title)
    FROM generated_test WHERE id = 3;
  `])
  if(updated.stdout.trim() !== 't')
    fail('generated prepared column did not update with title', updated.stdout)
  console.log('generated prepared column: passed')
}

function checkUpgrade() {
  loadSqlFile('fuzzy_upgrade', 'sql/pg_fuzzysearch--0.1.0.sql')
  loadSqlFile('fuzzy_upgrade', 'sql/pg_fuzzysearch--0.1.0--0.2.0.sql')
  const result = psql(['-Atc', `
    SELECT fuzzy_score('abc', fuzzy_prepare('abc')) = 1
       AND fuzzy_match('a', fuzzy_prepare('abc'))
       AND ((fuzzy_prepare('abc')::text) LIKE 'FX1:%');
  `], 'fuzzy_upgrade')
  if(result.stdout.trim() !== 't')
    fail('0.1.0 -> 0.2.0 upgrade did not expose prepared targets', result.stdout)
  console.log('0.1.0 -> 0.2.0 upgrade: passed')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
try {
  startCluster()
  loadFunctions()
  const file = scoreCaseFile()
  console.log(`prepared target cases: ${cases.length}`)
  checkPreparedCases(file)
  checkTypeAndIo()
  checkBinaryCopy()
  checkGeneratedColumn()
  checkUpgrade()
  console.log('\nPHASE 3 PREPARED-TARGET TESTS PASSED')
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
