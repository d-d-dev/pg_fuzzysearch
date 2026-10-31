# pg_fuzzysearch_dsf41

A PostgreSQL port of the search/matching core of
[fuzzysort](https://github.com/farzher/fuzzysort) 4.0.2.

**Current status:** Phase 4 is complete. The extension now has raw `text`
functions, prepared `fuzzy_target` values, ASCII fast paths, threshold pruning,
and parallel-scan benchmarks. Phase 5 is optional/release work. See
[PLAN.md](PLAN.md).

## What works today

- fuzzysort-compatible Unicode normalization/remapping/lowercasing.
- fuzzysort-compatible word-beginning indexes.
- Boolean subsequence matching, including multi-word queries.
- Exact fuzzysort scores and match indexes.
- Raw `text` SQL functions, query caching, and UTF-8 enforcement.
- Prepared `fuzzy_target` values, text/binary I/O, generated columns, and
  raw-vs-prepared parity.
- Compact ASCII prepared storage with version-1 compatibility.
- Allocation-free ASCII prefilter for raw searches.
- Threshold score-ceiling pruning and parallel-safe scans.
- Differential test harnesses for the C core, SQL layer, prepared targets, and
  integration behavior.

Phase 4 benchmark summary:

- Prepared storage: UE4 64 B vs 23 B raw; Steam 81 B vs 27 B raw.
- Prepared vs raw at threshold .5: up to 2.1x faster on common letter queries,
  3.8x on the 1M `item` query, and 1.7x on long descriptions.
- Prepared 1M synthetic `render` threshold .5: ~103 ms warm single-core;
  parallel 4 workers ~74 ms, 8 workers ~64 ms.
- Threshold `.8` prunes the 1M scan down to ~83 ms.
- Selective queries such as `rtrgt` can be faster on raw `text` because the
  allocation-free ASCII prefilter avoids reading prepared values.

## Build and test

Requirements: PostgreSQL 17, a C11 compiler, GNU make, and Node.js (used for
the reference harnesses and table generation).

```sh
make                 # standalone C core + parity CLI
make test-phase1     # core parity against fuzzysort
make pg              # PostgreSQL extension shared library
make test-phase2     # temporary PG17 cluster + raw SQL parity tests
make test-phase3     # prepared-target correctness tests
make test-phase4     # parallel/long-input integration tests
make bench-phase3    # raw vs prepared UE4/Steam benchmark
make bench-phase4    # threshold/parallel/1M benchmark
make test            # all parity and integration suites
```

The test harnesses load the reference implementation from `../fuzzysort`,
which is the clone already present in this workspace.

## Layout

```
src/fuzzy_core.c/.h   pure C matcher/scorer
src/normalize.c/.h    UTF-8/UTF-16 and fuzzysort normalization
src/tables.c/.h       generated Unicode tables
src/fuzzy_type.c/.h   prepared fuzzy_target varlena type
src/pg_fuzzysearch.c  PostgreSQL C glue
tools/gen_tables.mjs  table generator
tools/fuzzy_cli.c     standalone parity CLI
pg/                   PGXS build + control file
sql/                  0.1.0, 0.2.0, and upgrade SQL
test/phase1/run.mjs   core differential harness
test/phase2/run.mjs   SQL differential harness
test/phase3/run.mjs   prepared-target tests
test/phase3/bench.mjs raw vs prepared benchmark
test/phase4/run.mjs   parallel/long-input integration tests
test/phase4/bench.mjs full benchmark suite
PLAN.md               phased implementation plan
```

## SQL API

The extension exposes raw `text` functions:

```sql
fuzzy_match(query text, target text) RETURNS boolean
fuzzy_match(query text, target text, min_score double precision) RETURNS boolean
fuzzy_score(query text, target text) RETURNS double precision
fuzzy_normalize(value text) RETURNS text
fuzzy_normalize_query(value text) RETURNS text
```

Prepared targets are available in version 0.2.0:

```sql
fuzzy_prepare(target text) RETURNS fuzzy_target
fuzzy_match(query text, target fuzzy_target) RETURNS boolean
fuzzy_match(query text, target fuzzy_target, min_score double precision) RETURNS boolean
fuzzy_score(query text, target fuzzy_target) RETURNS double precision
```

Example:

```sql
ALTER TABLE items ADD COLUMN title_fuzzy fuzzy_target
  GENERATED ALWAYS AS (fuzzy_prepare(title)) STORED;

SELECT id, title, s.score
FROM items, LATERAL (
  SELECT fuzzy_score('rtrgt', items.title_fuzzy) AS score
) s
WHERE s.score >= 0.5
ORDER BY s.score DESC NULLS LAST, id
LIMIT 10;
```

`fuzzy_match(q, t, 0.5)` applies the usual fuzzysort quality threshold.
`fuzzy_score` returns `NULL` for no match and `0` for an empty query.

## Design notes

- Matching is subsequence-based, not edit-distance based.
- Scores are the fuzzysort normalized scores (`1` exact, `0` no match).
- Empty/effectively-empty queries match everything with score `0`; apply
  `score >= 0.5` for the usual fuzzysort quality filter.
- PostgreSQL 17 and UTF-8 databases only.
- No index support in the first release; Phase 4 focuses on a fast C scan.

## License

The port is based on fuzzysort (MIT). See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
