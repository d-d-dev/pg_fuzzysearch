# pg_fuzzysearch_dsf41

A PostgreSQL port of the search/matching core of
[fuzzysort](https://github.com/farzher/fuzzysort) 4.0.2.

**Current status:** Phase 2 is complete. The pure C core and the raw `text`
PostgreSQL functions are implemented and verified against the JavaScript
reference. Prepared targets are Phase 3. See [PLAN.md](PLAN.md).

## What works today

- fuzzysort-compatible Unicode normalization/remapping/lowercasing.
- fuzzysort-compatible word-beginning indexes.
- Boolean subsequence matching, including multi-word queries.
- Exact fuzzysort scores and match indexes.
- Raw `text` SQL functions, query caching, and UTF-8 enforcement.
- Differential test harnesses for both the C core and the SQL layer.

Phase 2 SQL result:

```
basic SQL API: passed
score cases: 7442/7442 passed
normalization cases: 63487/63487 passed
non-UTF-8 rejection: passed
PHASE 2 SQL PARITY PASSED
```

## Build and test

Requirements: PostgreSQL 17, a C11 compiler, GNU make, and Node.js (used for
the reference harnesses and table generation).

```sh
make                 # standalone C core + parity CLI
make test-phase1     # core parity against fuzzysort
make pg              # PostgreSQL extension shared library
make test-phase2     # temporary PG17 cluster + SQL parity tests
make test            # both parity suites
```

The test harnesses load the reference implementation from `../fuzzysort`,
which is the clone already present in this workspace.

## Layout

```
src/fuzzy_core.c/.h   pure C matcher/scorer
src/normalize.c/.h    UTF-8/UTF-16 and fuzzysort normalization
src/tables.c/.h       generated Unicode tables
src/pg_fuzzysearch.c  PostgreSQL C glue
tools/gen_tables.mjs  table generator
tools/fuzzy_cli.c     standalone parity CLI
pg/                   PGXS build + control file
sql/                  extension SQL script
test/phase1/run.mjs   core differential harness
test/phase2/run.mjs   SQL differential harness
PLAN.md               phased implementation plan
```

## SQL API

Phase 2 exposes raw `text` functions:

```sql
fuzzy_match(query text, target text) RETURNS boolean
fuzzy_match(query text, target text, min_score double precision) RETURNS boolean
fuzzy_score(query text, target text) RETURNS double precision
fuzzy_normalize(value text) RETURNS text
fuzzy_normalize_query(value text) RETURNS text
```

Example:

```sql
SELECT id, title, s.score
FROM items, LATERAL (
  SELECT fuzzy_score('rtrgt', items.title) AS score
) s
WHERE s.score >= 0.5
ORDER BY s.score DESC NULLS LAST, id
LIMIT 10;
```

`fuzzy_match(q, t, 0.5)` applies the usual fuzzysort quality threshold.
`fuzzy_score` returns `NULL` for no match and `0` for an empty query.

Phase 3 will add a prepared target type and generated-column support:

```sql
ALTER TABLE items ADD COLUMN title_fuzzy fuzzy_target
  GENERATED ALWAYS AS (fuzzy_prepare(title)) STORED;
```

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
