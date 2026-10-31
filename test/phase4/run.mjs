#!/usr/bin/env node
/*
 * Phase 4 integration checks: parallel plans, long/adversarial inputs, and
 * repeated-query stability on top of the correctness suites.
 *
 * Run from the project root:
 *   make test-phase4
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import { userInfo } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '../..')
const pgConfig = process.env.PG_CONFIG || 'pg_config'
const bindir = spawnSync(pgConfig, ['--bindir'], {encoding: 'utf8'}).stdout.trim()
const initdb = join(bindir, 'initdb')
const pgCtl = join(bindir, 'pg_ctl')
const psqlBin = join(bindir, 'psql')
const user = userInfo().username
const socketDir = '/tmp/opencode'
const port = process.env.PG_TEST_PORT || '55446'
const clusterDir = mkdtempSync(join(socketDir, 'pg_fuzzy_phase4_'))
const logFile = join(clusterDir, 'postgres.log')
let started = false

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024, ...options})
  if(result.error) throw result.error
  if(result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`)
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
  run(pgCtl, ['-D', clusterDir, '-o', `-p ${port} -k ${socketDir} -c listen_addresses=''`,
              '-l', logFile, '-w', 'start'])
  started = true
  run(psqlBin, ['-h', socketDir, '-p', port, '-U', user, '-d', 'postgres',
                '-v', 'ON_ERROR_STOP=1', '-c', 'CREATE DATABASE fuzzy_test;'])
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

function count(sql, setup = '') {
  const lines = psql(['-Atc', `${setup} ${sql}`]).stdout.trim().split('\n')
    .filter(line => /^\d+$/.test(line))
  return Number(lines[lines.length - 1])
}

try {
  startCluster()
  loadSql()

  psql(['-c', `
    CREATE TABLE synthetic (
      title text,
      title_fuzzy fuzzy_target GENERATED ALWAYS AS (fuzzy_prepare(title)) STORED
    );
    INSERT INTO synthetic (title)
    SELECT 'item ' || g || ' ' || md5(g::text) || ' ' || md5((g::bigint * 7919)::text)
    FROM generate_series(1, 200000) g;
    ANALYZE synthetic;
  `])

  const query = "SELECT count(*) FROM synthetic WHERE fuzzy_match('render', title_fuzzy, 0.5);"
  const serial = count(query, 'SET max_parallel_workers_per_gather = 0;')
  const parallel = count(query, `
    SET max_parallel_workers_per_gather = 4;
    SET parallel_setup_cost = 0;
    SET parallel_tuple_cost = 0;
    SET min_parallel_table_scan_size = 0;
  `)
  if(serial !== parallel)
    throw new Error(`serial/parallel count mismatch: ${serial} != ${parallel}`)

  const plan = psql(['-Atc', `
    SET max_parallel_workers_per_gather = 4;
    SET parallel_setup_cost = 0;
    SET parallel_tuple_cost = 0;
    SET min_parallel_table_scan_size = 0;
    EXPLAIN (ANALYZE, TIMING OFF, SUMMARY ON) ${query}
  `]).stdout
  const workers = Number((plan.match(/Workers Launched: (\d+)/) || [0, 0])[1])
  if(workers < 1)
    throw new Error(`parallel plan did not launch workers:\n${plan}`)
  console.log(`parallel plan: ${workers} workers, serial/parallel counts ${serial}/${parallel}`)

  // Adversarial backtracking input from fuzzysort's test suite.  The statement
  // timeout catches an accidental exponential path.
  psql(['-f', '-'], `
    SET statement_timeout = '2s';
    SELECT fuzzy_match('aaaaaaaaaaab', repeat('a ', 5000) || 'xb');
    SELECT fuzzy_score('prrun', 'C:/users/farzher/dropbox/someotherfolder/pocket rumble refactor/Run.bat');
  `)
  console.log('long/adversarial inputs: passed')

  // Repeated prepared scans exercise fn_extra scratch reuse and query-cache
  // replacement without growing unboundedly.
  psql(['-f', '-'], `
    SET statement_timeout = '10s';
    DO $$
    BEGIN
      FOR i IN 1..100 LOOP
        PERFORM count(*) FROM synthetic
        WHERE fuzzy_match('render', title_fuzzy, 0.5);
      END LOOP;
    END $$;
  `)
  console.log('repeated prepared scans: passed')

  console.log('\nPHASE 4 INTEGRATION TESTS PASSED')
} catch(error) {
  console.error(error.message)
  if(started) console.error(`cluster log: ${logFile}`)
  process.exitCode = 1
} finally {
  stopCluster()
  if(!process.exitCode) rmSync(clusterDir, {recursive: true, force: true})
}
