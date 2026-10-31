#!/usr/bin/env node
/*
 * Phase 4 reproducible benchmark suite.
 *
 * Covers:
 *   - UE4 (13k) and Steam (183k) raw vs prepared
 *   - 1M synthetic titles
 *   - threshold 0 / .5 / .8
 *   - single-worker vs parallel prepared scans
 *   - long descriptions where score-ceiling pruning matters
 *
 * Run from the project root:
 *   make bench-phase4
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import { tmpdir, userInfo } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '../..')
const pgConfig = process.env.PG_CONFIG || 'pg_config'
const bindir = spawnSync(pgConfig, ['--bindir'], {encoding: 'utf8'}).stdout.trim()
const initdb = join(bindir, 'initdb')
const pgCtl = join(bindir, 'pg_ctl')
const psqlBin = join(bindir, 'psql')
const user = userInfo().username
const socketDir = '/tmp/opencode'
const port = process.env.PG_BENCH_PORT || '55445'
const clusterDir = mkdtempSync(join(socketDir, 'pg_fuzzy_bench4_'))
const caseDir = mkdtempSync(join(tmpdir(), 'pg_fuzzy_bench4_cases_'))
const logFile = join(clusterDir, 'postgres.log')

let started = false

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024, ...options})
  if(result.error) throw result.error
  if(result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`)
  return result
}
function psql(args, input, db = 'fuzzy_bench') {
  return run(psqlBin, [
    '-h', socketDir, '-p', port, '-U', user, '-d', db,
    '-v', 'ON_ERROR_STOP=1', ...args,
  ], {input})
}
function startCluster() {
  rmSync(clusterDir, {recursive: true, force: true})
  run(initdb, ['-D', clusterDir, '-U', user, '--no-locale', '-E', 'UTF8'])
  run(pgCtl, ['-D', clusterDir, '-o', `-p ${port} -k ${socketDir} -c listen_addresses='' -c shared_buffers=512MB -c jit=off`,
              '-l', logFile, '-w', 'start'])
  started = true
  run(psqlBin, [
    '-h', socketDir, '-p', port, '-U', user, '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-c', 'CREATE DATABASE fuzzy_bench;',
  ])
}
function stopCluster() {
  if(!started) return
  try {
    run(pgCtl, ['-D', clusterDir, '-m', 'immediate', '-w', 'stop'])
  } finally {
    started = false
  }
}
function loadSql() {
  const sql = readFileSync(resolve(projectRoot, 'sql/pg_fuzzysearch--0.2.0.sql'), 'utf8')
    .replaceAll('MODULE_PATHNAME', resolve(projectRoot, 'pg/pg_fuzzysearch.so'))
    .split('\n').filter(line => !line.startsWith('\\echo')).join('\n')
  psql(['-f', '-'], sql)
}
function csvField(value) { return '"' + value.replace(/"/g, '""') + '"' }
function writeCsv(name, values) {
  const file = join(caseDir, name)
  writeFileSync(file, values.map(csvField).join('\n') + '\n')
  return file
}
function loadJson(name) {
  return JSON.parse(readFileSync(resolve(projectRoot, `../fuzzysort/test/${name}.json`), 'utf8'))
}
function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}
function explain(sql, setup = '', reps = 3) {
  const samples = []
  let workers = null

  /* One untimed warm-up keeps cold-cache effects out of the median, especially
   * after the long-description table has pushed other relations out of cache. */
  psql(['-Atc', `${setup} EXPLAIN (ANALYZE, TIMING OFF, SUMMARY ON) ${sql}`])

  for(let i = 0; i < reps; i++) {
    const result = psql(['-Atc', `${setup} EXPLAIN (ANALYZE, TIMING OFF, SUMMARY ON) ${sql}`])
    const time = result.stdout.match(/Execution Time: ([\d.]+) ms/)
    if(!time) throw new Error(`could not parse EXPLAIN:\n${result.stdout}`)
    samples.push(Number(time[1]))
    const w = result.stdout.match(/Workers Launched: (\d+)/)
    if(w) workers = Number(w[1])
  }
  return {ms: median(samples), workers}
}
function printRow(...cols) {
  console.log(cols.join('\t'))
}

function main() {
  startCluster()
  loadSql()
  psql(['-c', `
    CREATE TABLE ue4 (
      title text,
      title_fuzzy fuzzy_target GENERATED ALWAYS AS (fuzzy_prepare(title)) STORED
    );
    CREATE TABLE steam (
      title text,
      title_fuzzy fuzzy_target GENERATED ALWAYS AS (fuzzy_prepare(title)) STORED
    );
    CREATE TABLE synthetic (
      title text,
      title_fuzzy fuzzy_target GENERATED ALWAYS AS (fuzzy_prepare(title)) STORED
    );
    CREATE TABLE longdesc (
      body text,
      body_fuzzy fuzzy_target GENERATED ALWAYS AS (fuzzy_prepare(body)) STORED
    );
  `])

  const ue4File = writeCsv('ue4.csv', loadJson('ue4_files'))
  const steamFile = writeCsv('steam.csv', loadJson('steam_games'))
  let start = performance.now()
  psql(['-c', `\\copy ue4 (title) FROM '${ue4File}' WITH (FORMAT csv)`])
  const ue4Load = performance.now() - start
  start = performance.now()
  psql(['-c', `\\copy steam (title) FROM '${steamFile}' WITH (FORMAT csv)`])
  const steamLoad = performance.now() - start
  start = performance.now()
  psql(['-c', `
    INSERT INTO synthetic (title)
    SELECT 'item ' || g || ' ' || md5(g::text) || ' ' || md5((g::bigint * 7919)::text)
    FROM generate_series(1, 1000000) g;
  `])
  const syntheticLoad = performance.now() - start
  psql(['-c', `
    INSERT INTO longdesc (body)
    SELECT repeat('the quick brown fox jumps over the lazy dog. ', 200) || ' needle' || g
    FROM generate_series(1, 1000) g;
  `])
  psql(['-c', 'ANALYZE ue4; ANALYZE steam; ANALYZE synthetic; ANALYZE longdesc;'])

  console.log('load times (including generated preparation):')
  console.log(`ue4=${ue4Load.toFixed(0)} ms steam=${steamLoad.toFixed(0)} ms synthetic=${syntheticLoad.toFixed(0)} ms`)
  console.log('\nrelation sizes:')
  console.log(psql(['-Atc', `
    SELECT 'ue4', count(*), pg_size_pretty(pg_total_relation_size('ue4')),
           round(avg(pg_column_size(title))::numeric, 1),
           round(avg(pg_column_size(title_fuzzy))::numeric, 1) FROM ue4
    UNION ALL
    SELECT 'steam', count(*), pg_size_pretty(pg_total_relation_size('steam')),
           round(avg(pg_column_size(title))::numeric, 1),
           round(avg(pg_column_size(title_fuzzy))::numeric, 1) FROM steam
    UNION ALL
    SELECT 'synthetic', count(*), pg_size_pretty(pg_total_relation_size('synthetic')),
           round(avg(pg_column_size(title))::numeric, 1),
           round(avg(pg_column_size(title_fuzzy))::numeric, 1) FROM synthetic
    UNION ALL
    SELECT 'longdesc', count(*), pg_size_pretty(pg_total_relation_size('longdesc')),
           round(avg(pg_column_size(body))::numeric, 1),
           round(avg(pg_column_size(body_fuzzy))::numeric, 1) FROM longdesc;
  `]).stdout.trim())

  console.log('\nthreshold matrix (prepared, median ms):')
  printRow('table', 'query', 'threshold=0', 'threshold=.5', 'threshold=.8')
  for(const [table, column, queries] of [
    ['ue4', 'title_fuzzy', ['e', 'render', 'rtrgt']],
    ['steam', 'title_fuzzy', ['e', 'el', 'render']],
    ['synthetic', 'title_fuzzy', ['render', 'item', 'zzzzzz']],
    ['longdesc', 'body_fuzzy', ['needle', 'the', 'zzzzzz']],
  ]) {
    for(const q of queries) {
      const times = [0, .5, .8].map(t =>
        explain(`SELECT count(*) FROM ${table} WHERE fuzzy_match('${q}', ${column}, ${t});`).ms)
      printRow(table, q, ...times.map(x => x.toFixed(2)))
    }
  }

  console.log('\nraw vs prepared, threshold .5 (median ms):')
  printRow('table', 'query', 'raw', 'prepared', 'speedup')
  for(const [table, rawcol, prepcol, queries] of [
    ['ue4', 'title', 'title_fuzzy', ['e', 'el', 'eld', 'render', 'rtrgt']],
    ['steam', 'title', 'title_fuzzy', ['e', 'el', 'eld', 'render']],
    ['synthetic', 'title', 'title_fuzzy', ['render', 'item', 'zzzzzz']],
    ['longdesc', 'body', 'body_fuzzy', ['needle', 'the', 'zzzzzz']],
  ]) {
    for(const q of queries) {
      const raw = explain(`SELECT count(*) FROM ${table} WHERE fuzzy_match('${q}', ${rawcol}, 0.5);`).ms
      const prep = explain(`SELECT count(*) FROM ${table} WHERE fuzzy_match('${q}', ${prepcol}, 0.5);`).ms
      printRow(table, q, raw.toFixed(2), prep.toFixed(2), (raw / prep).toFixed(2) + 'x')
    }
  }

  console.log('\nparallel scan on synthetic (prepared, query render, threshold .5):')
  printRow('workers', 'execution ms', 'launched')
  for(const workers of [0, 2, 4, 8]) {
    const setup = `
      SET max_parallel_workers_per_gather = ${workers};
      SET parallel_setup_cost = 0;
      SET parallel_tuple_cost = 0;
      SET min_parallel_table_scan_size = 0;`
    const result = explain(`SELECT count(*) FROM synthetic WHERE fuzzy_match('render', title_fuzzy, 0.5);`, setup)
    printRow(workers, result.ms.toFixed(2), result.workers ?? 0)
  }

  console.log('\nordered top-10 (median ms):')
  printRow('table', 'query', 'raw', 'prepared', 'speedup')
  for(const [table, rawcol, prepcol, queries] of [
    ['ue4', 'title', 'title_fuzzy', ['render', 'rtrgt']],
    ['steam', 'title', 'title_fuzzy', ['render']],
    ['synthetic', 'title', 'title_fuzzy', ['render']],
  ]) {
    for(const q of queries) {
      const raw = explain(`
        SELECT title, s.score FROM ${table}, LATERAL (
          SELECT fuzzy_score('${q}', ${rawcol}) AS score
        ) s WHERE s.score >= 0.5 ORDER BY s.score DESC NULLS LAST LIMIT 10;`).ms
      const prep = explain(`
        SELECT title, s.score FROM ${table}, LATERAL (
          SELECT fuzzy_score('${q}', ${prepcol}) AS score
        ) s WHERE s.score >= 0.5 ORDER BY s.score DESC NULLS LAST LIMIT 10;`).ms
      printRow(table, q, raw.toFixed(2), prep.toFixed(2), (raw / prep).toFixed(2) + 'x')
    }
  }
}

try {
  main()
  console.log('\nPHASE 4 BENCHMARK COMPLETE')
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
