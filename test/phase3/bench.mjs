#!/usr/bin/env node
/*
 * Phase 3 raw-text vs prepared-target benchmark.
 *
 * Starts a temporary PostgreSQL 17 cluster, loads UE4 and Steam titles into
 * tables with a generated prepared column, and measures warm single-core
 * execution times for the same queries against raw text and fuzzy_target.
 *
 * Run from the project root:
 *   make bench-phase3
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
const port = process.env.PG_BENCH_PORT || '55444'
const clusterDir = mkdtempSync(join(socketDir, 'pg_fuzzy_bench3_'))
const caseDir = mkdtempSync(join(tmpdir(), 'pg_fuzzy_bench3_cases_'))
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
  run(pgCtl, ['-D', clusterDir, '-o', `-p ${port} -k ${socketDir} -c listen_addresses=''`,
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

function loadSql(file, db = 'fuzzy_bench') {
  let sql = readFileSync(resolve(projectRoot, file), 'utf8')
    .replaceAll('MODULE_PATHNAME', resolve(projectRoot, 'pg/pg_fuzzysearch.so'))
    .split('\n').filter(line => !line.startsWith('\\echo')).join('\n')
  psql(['-f', '-'], sql, db)
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

function executionMs(sql) {
  const result = psql(['-Atc', `EXPLAIN (ANALYZE, TIMING OFF, SUMMARY ON) ${sql}`])
  const match = result.stdout.match(/Execution Time: ([\d.]+) ms/)
  if(!match) throw new Error(`could not parse EXPLAIN output:\n${result.stdout}`)
  return Number(match[1])
}
function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}
function measure(sql, reps = 3) {
  const samples = []
  for(let i = 0; i < reps; i++) samples.push(executionMs(sql))
  return median(samples)
}

function main() {
  startCluster()
  loadSql('sql/pg_fuzzysearch--0.2.0.sql')

  psql(['-c', `
    CREATE TABLE ue4 (
      title text,
      title_fuzzy fuzzy_target GENERATED ALWAYS AS (fuzzy_prepare(title)) STORED
    );
    CREATE TABLE steam (
      title text,
      title_fuzzy fuzzy_target GENERATED ALWAYS AS (fuzzy_prepare(title)) STORED
    );
  `])

  const ue4 = loadJson('ue4_files')
  const steam = loadJson('steam_games')
  const ue4File = writeCsv('ue4.csv', ue4)
  const steamFile = writeCsv('steam.csv', steam)

  let start = performance.now()
  psql(['-c', `\\copy ue4 (title) FROM '${ue4File}' WITH (FORMAT csv)`])
  const ue4Load = performance.now() - start
  start = performance.now()
  psql(['-c', `\\copy steam (title) FROM '${steamFile}' WITH (FORMAT csv)`])
  const steamLoad = performance.now() - start
  psql(['-c', 'ANALYZE ue4; ANALYZE steam;'])

  const sizes = psql(['-Atc', `
    SELECT 'ue4', count(*),
           pg_size_pretty(pg_total_relation_size('ue4')),
           round(avg(pg_column_size(title))::numeric, 1),
           round(avg(pg_column_size(title_fuzzy))::numeric, 1)
    FROM ue4
    UNION ALL
    SELECT 'steam', count(*),
           pg_size_pretty(pg_total_relation_size('steam')),
           round(avg(pg_column_size(title))::numeric, 1),
           round(avg(pg_column_size(title_fuzzy))::numeric, 1)
    FROM steam;
  `])
  console.log('relation sizes:')
  console.log(sizes.stdout.trim())
  console.log(`load time: ue4=${ue4Load.toFixed(0)} ms, steam=${steamLoad.toFixed(0)} ms (including generated preparation)`)

  const queries = {
    ue4: ['e', 'el', 'eld', 'render', 'rtrgt'],
    steam: ['e', 'el', 'eld', 'render'],
  }
  console.log('\nmatch-only, threshold 0.5 (median execution ms):')
  console.log('table\tquery\traw\tprepared\tspeedup')
  for(const [table, qs] of Object.entries(queries)) {
    for(const q of qs) {
      const raw = measure(`SELECT count(*) FROM ${table} WHERE fuzzy_match('${q}', title, 0.5);`)
      const prep = measure(`SELECT count(*) FROM ${table} WHERE fuzzy_match('${q}', title_fuzzy, 0.5);`)
      console.log(`${table}\t${q}\t${raw.toFixed(2)}\t${prep.toFixed(2)}\t${(raw / prep).toFixed(2)}x`)
    }
  }

  console.log('\nordered top-10 (median execution ms):')
  console.log('table\tquery\traw\tprepared\tspeedup')
  for(const [table, qs] of Object.entries(queries)) {
    for(const q of qs) {
      const raw = measure(`
        SELECT title, s.score
        FROM ${table}, LATERAL (SELECT fuzzy_score('${q}', title) AS score) s
        WHERE s.score >= 0.5
        ORDER BY s.score DESC NULLS LAST
        LIMIT 10;`)
      const prep = measure(`
        SELECT title, s.score
        FROM ${table}, LATERAL (SELECT fuzzy_score('${q}', title_fuzzy) AS score) s
        WHERE s.score >= 0.5
        ORDER BY s.score DESC NULLS LAST
        LIMIT 10;`)
      console.log(`${table}\t${q}\t${raw.toFixed(2)}\t${prep.toFixed(2)}\t${(raw / prep).toFixed(2)}x`)
    }
  }
}

try {
  main()
  console.log('\nPHASE 3 BENCHMARK COMPLETE')
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
