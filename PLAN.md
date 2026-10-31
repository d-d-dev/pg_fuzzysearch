# pg_fuzzysearch_dsf41 — Implementation Plan

**Status:** Phase 2 complete. Phases 3–5 remain.
**Target:** PostgreSQL 17, UTF-8 databases only.
**Reference implementation:** `fuzzysort` 4.0.2, commit `ac4d42ec894a2125d78802ec9b5e74e43518d0fc` (the clone in `../fuzzysort`).
**Project root:** `pg_fuzzysearch_dsf41/`

---

## 1. Product decisions

These decisions are fixed for the current plan:

1. **Scoring is included.** PostgreSQL will sort with `ORDER BY fuzzy_score(...)`, so the port must reproduce fuzzysort's score, not just its boolean match result.
2. **Empty/effectively-empty queries match everything with score `0`.** A query that normalizes to nothing (empty string, whitespace-only, or characters that remap to whitespace) has score `0`. With the usual `>= 0.5` threshold it produces no results until the user types something meaningful.
3. **No index support in the first release.** The primary execution strategy is a C predicate over a sequential/parallel scan. Index work is a later, optional phase.
4. **Static Unicode tables.** Normalization tables are generated from the pinned fuzzysort/Node reference. The extension will not depend on ICU at runtime.
5. **PostgreSQL 17 and UTF-8 only.** Non-UTF-8 server encodings will be rejected by the SQL functions.
6. **fuzzysort's heap/limit/total logic is out of scope.** PostgreSQL's `ORDER BY`/`LIMIT` and `count(*)` replace it. fuzzysort's score and threshold semantics remain in scope.
7. **One searchable value per function call.** Multi-key/object semantics (`keys`, `scoreFn`) are deferred. Multi-column ranking can be added later with a separate function if required.

### Match semantics we must preserve

- Without whitespace: match iff the normalized query is a subsequence of the normalized target.
- With whitespace: each unique whitespace-separated part must be a subsequence. Parts may match out of order; ordering affects score.
- This is **not** edit distance: `abc` does not match `acb`.
- The default fuzzysort quality filter is score `>= 0.5`; our SQL API will expose that explicitly.
- An empty/effectively-empty query matches everything with score `0` (deliberate divergence from fuzzysort's inconsistent `single('')` behavior).

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ PostgreSQL SQL layer (Phase 2+)                             │
│  fuzzy_match(), fuzzy_score(), fuzzy_prepare(), type I/O    │
│  fn_extra query cache, UTF-8 validation, parallel-safe glue  │
└─────────────────────────────┬───────────────────────────────┘
                              │
┌─────────────────────────────▼───────────────────────────────┐
│ Prepared target type (Phase 3)                              │
│  normalized UTF-16/ASCII codes, bitflags, word beginnings    │
│  first-letter table, format version                          │
└─────────────────────────────┬───────────────────────────────┘
                              │
┌─────────────────────────────▼───────────────────────────────┐
│ Pure C core (Phase 1 — complete)                            │
│  UTF-16 normalization, remap/lowercase, bitflags,           │
│  beginnings, algorithm1/2/general/spaces, scoring           │
└─────────────────────────────────────────────────────────────┘
```

The pure core is deliberately independent of PostgreSQL so it can be tested,
fuzzed, and benchmarked without a database. SQL glue will convert `text` to
UTF-8 bytes, call the core, and own memory-context/caching concerns.

### Repository layout

```
pg_fuzzysearch_dsf41/
├── Makefile
├── PLAN.md
├── README.md
├── THIRD_PARTY_NOTICES.md
├── src/
│   ├── fuzzy_core.c/.h      pure C matcher and scorer
│   ├── normalize.c/.h       UTF-8/UTF-16, remap, lowercase, bitflags, beginnings
│   ├── tables.c/.h          generated static Unicode tables
│   └── pg_fuzzysearch.c     PostgreSQL C glue (Phase 2)
├── tools/
│   ├── gen_tables.mjs       regenerates src/tables.c/.h
│   └── fuzzy_cli.c          standalone parity/benchmark CLI
├── pg/
│   ├── Makefile             PGXS build
│   └── pg_fuzzysearch.control
├── sql/
│   └── pg_fuzzysearch--0.1.0.sql
└── test/
    ├── phase1/run.mjs       core differential parity harness
    └── phase2/run.mjs       temporary-cluster SQL parity harness
```

Phase 3 will add:

```
src/fuzzy_type.c           prepared target varlena type
sql/pg_fuzzysearch--0.2.0.sql
test/phase3/                raw-vs-prepared and type I/O tests
```

---

## 3. Phase 1 — Pure C core and reference parity (COMPLETE)

### Objective

Implement the fuzzysort normalization, matching, and scoring algorithms in
standalone C, and prove exact parity against the JavaScript reference before any
PostgreSQL code exists.

### Deliverables (all present)

- UTF-8 → UTF-16 conversion and back.
- fuzzysort-compatible remapping:
  - built-in quote/dash/lookalike table;
  - NFKD only when the normalized result is exactly one UTF-16 code unit;
  - strip only `U+0300–U+036F`;
  - ASCII `"`, `\`, and backtick remapping.
- JavaScript-compatible `trim()`/`\s` handling.
- JavaScript-compatible lowercasing, including Greek `Final_Sigma`.
- Bitflags, word beginnings, and first-letter table.
- Boolean fast path (bitflags + subsequence).
- Full scorer:
  - two-character `algorithm2`;
  - general `algorithm`;
  - whitespace `algorithmSpaces`;
  - score calculation and normalized-score curve.
- Standalone CLI (`build/fuzzy_cli`) with modes:
  - `score`
  - `normalize-query`
  - `normalize-target`
  - `beginnings`
- Differential harness (`make test-phase1`) against fuzzysort.

### Unicode table generation

`tools/gen_tables.mjs` generates static tables from the pinned Node reference:

- 2,652 BMP remap exceptions.
- 1,488 lowercase exceptions (BMP + supplementary).
- Compressed `Cased`, `Case_Ignorable`, and ECMAScript whitespace ranges.
- Tables are committed; `make tables` regenerates them.

This avoids an ICU runtime dependency and pins behavior to the same Unicode
version as the test reference.

### Test corpus

The harness covers:

- All BMP code units for normalization and beginnings.
- Every code point that changes under remap/lowercase.
- Curated cases from fuzzysort's `test.js`: sorting, spaces, duplicate terms,
  camel case, remapping, diacritics, emoji, CJK, Greek sigma, long targets,
  backtracking, empty inputs.
- Complete UE4 dataset (13,164 strings) × 16 queries.
- 4,000 sampled Steam titles × 8 queries.
- Pokémon, URL/title, movie quote, and emoji datasets.
- 3,000 deterministic random score cases plus random normalization/beginnings
  inputs.
- Targets at 0, 1, 2, 3, 23, 24, 25, 64, 100, 999, 1000, 65534, 65535, 65536
  characters.

### Phase 1 results

`make test-phase1`:

```
query normalization: 70899/70899 passed
target normalization: 90517/90517 passed
beginnings: 90531/90531 passed
score: 257820/257820 passed (52387 matches)
PHASE 1 PARITY PASSED
```

Raw scores, normalized scores, boolean matches, and indexes all match on the
test corpus. Scores are compared with tolerance for library `pow` differences;
the harness also compares raw scores to separate algorithm bugs from floating
point normalization.

### Phase 1 known limitations

- Core stores and matches UTF-16 only; the ASCII fast path and deferred target
  normalization come in Phase 4.
- No threshold/cutoff parameter is exposed yet. The full score is available;
  threshold comparison will be added with the SQL layer.
- Core uses `malloc`/`realloc`; PostgreSQL memory contexts and per-query scratch
  reuse come later.
- No prepared target type yet.
- No ASAN run yet: the current machine is missing `libasan`, so sanitizer work is
  queued for CI/Phase 4.

### Phase 1 exit criteria — met

- 100% match parity on the test corpus.
- 100% score parity within tolerance.
- 100% index parity.
- Normalization and beginnings verified independently.
- `make test-phase1` is fast (~1.5 s) and deterministic.

---

## 4. Phase 2 — PostgreSQL extension shell and raw `text` functions (COMPLETE)

### Objective

Expose the already-tested core through PostgreSQL 17 without yet adding a
prepared target type or index.

### Deliverables (all present)

- PGXS project:
  - `pg/pg_fuzzysearch.control`
  - `sql/pg_fuzzysearch--0.1.0.sql`
  - `src/pg_fuzzysearch.c`
  - `pg/Makefile` with `MODULE_big`, `EXTENSION`, `DATA`
- SQL API on raw `text`:

```sql
fuzzy_match(query text, target text) RETURNS boolean
fuzzy_match(query text, target text, min_score double precision) RETURNS boolean
fuzzy_score(query text, target text) RETURNS double precision
fuzzy_normalize(value text) RETURNS text
fuzzy_normalize_query(value text) RETURNS text
```

Semantics:

- `fuzzy_match(q,t)` — true for any subsequence match.
- `fuzzy_match(q,t,min_score)` — true iff the normalized score is at least
  `min_score`.
- `fuzzy_score(q,t)` — normalized score in `(0,1]`, `NULL` when there is no
  match, and `0` for an empty/effectively-empty query.
- All functions `STRICT`, `IMMUTABLE`, `PARALLEL SAFE`.
- Reject non-UTF-8 database encodings with a clear error.
- `fuzzy_normalize` / `fuzzy_normalize_query` are diagnostic/parity helpers.

### PostgreSQL glue details (implemented)

- Decode `text` with `PG_GETARG_TEXT_PP` / `VARDATA_ANY`; no `text_to_cstring`
  copies.
- Detoast once per call.
- Cache the normalized query in `fn_extra`/`fn_mcxt`, keyed by query bytes.
- Memory-context reset callback frees the malloc-backed query/scratch state.
- Per-row target preparation is owned and freed by the SQL glue.
- No global mutable state.
- Core stays independent of PostgreSQL headers.
- Allocation failures map to PostgreSQL errors; scratch OOM is distinguished
  from "no match".
- Document:

```sql
SELECT id, title, s.score
FROM items, LATERAL (
  SELECT fuzzy_score('rtrgt', items.title) AS score
) s
WHERE s.score >= 0.5
ORDER BY s.score DESC NULLS LAST, id
LIMIT 10;
```

`NULLS LAST` is required because PostgreSQL sorts `NULL` first by default with
`DESC`.

### Testing (implemented)

- `test/phase2/run.mjs` starts a temporary PostgreSQL 17 cluster, loads the SQL
  with an absolute `.so` path, and runs:
  - API shape, `STRICT`, NULL, empty/whitespace query assertions;
  - function volatility/parallel/strict property checks;
  - threshold boundaries `0`, `.5`, `1`, and `-1`;
  - changing query text per row to exercise `fn_extra` invalidation;
  - prepared `EXECUTE` reuse across executions;
  - 7,442 fuzzysort-generated score cases;
  - 63,487 all-BMP normalization cases;
  - non-UTF-8 database rejection.
- `make -C pg install DESTDIR=...` was verified to install the `.so`, control
  file, and SQL script in the expected layout.
- The environment does not permit writing to the system extension directory, so
  the test harness loads the built `.so` directly instead of using
  `CREATE EXTENSION`; packaging itself is verified with `DESTDIR`.
- `pg_regress` is deferred to CI/release, where a real extension install is
  available.

### Phase 2 results

`make test-phase2`:

```
basic SQL API: passed
score cases: 7442/7442 passed
normalization cases: 63487/63487 passed
non-UTF-8 rejection: passed
PHASE 2 SQL PARITY PASSED
```

Initial raw-text baseline on this machine (PostgreSQL 17.11, single core, warm
cache, `fuzzy_match(query, title, 0.5)`):

- UE4, 13,164 rows: ~3.8–4.9 ms for queries `e`, `el`, `eld`, `render`, `rtrgt`.
- Steam, 182,964 rows: ~61–65 ms for `e`, `el`, `eld`, `render`.
- UE4 `ORDER BY fuzzy_score('render', title) DESC LIMIT 10`: ~4.2 ms.

These are indicative numbers only; Phase 4 owns the reproducible benchmark
suite and prepared-target comparison.

### Phase 2 known limitations

- Target normalization still runs on every row; prepared targets are Phase 3.
- `fuzzy_match(query,target,min_score)` computes the full score; threshold
  ceiling pruning is Phase 4.
- The initial raw-text timing is recorded above; the full reproducible benchmark
  suite (prepared targets, parallel plans, 1M rows) is Phase 4.
- No `pg_regress` target yet because the system extension directory is not
  writable in this environment.

### Phase 2 exit criteria

- Extension builds with PGXS — met.
- All raw-function parity tests pass — met.
- No crashes under repeated/varying queries — covered by the test corpus.
- Full performance baseline — deferred to Phase 4 by design.

---

## 5. Phase 3 — Prepared target type

### Objective

Remove repeated target normalization and beginning construction, which is the
largest per-row cost for ranked searches.

### Prepared type

Add a varlena type, tentatively `fuzzy_target`:

```c
fuzzy_target:
  header: magic/format version, bitflags, has_space, ascii flag,
          target_len (UTF-16 code units), beginnings_len
  first_begin[26]
  beginnings[]        uint32 offsets
  lower[]             uint8 ASCII or uint16 UTF-16
```

- `fuzzy_prepare(target text) RETURNS fuzzy_target`.
- Overloads:
  - `fuzzy_match(query text, target fuzzy_target [, min_score])`
  - `fuzzy_score(query text, target fuzzy_target)`
- Type I/O:
  - text output for display;
  - binary send/recv for COPY;
  - version/magic validation on input;
  - document that normalization-version upgrades require re-preparing stored
    values.
- Recommended usage:

```sql
ALTER TABLE items ADD COLUMN title_fuzzy fuzzy_target
  GENERATED ALWAYS AS (fuzzy_prepare(title)) STORED;
```

Generated columns are recomputed on dump/restore and avoid stale prepared data.

### Query cache integration

The raw-text query cache was implemented in Phase 2. Phase 3 extends it to the
prepared-target overloads:

- reuse the same `fn_extra` cache and per-query scratch buffers;
- validate cached query bytes for generic plans;
- never cache per-row raw targets.

### Testing

- Raw vs prepared score/index equality over the Phase 1 corpus.
- Generated column and plain prepared column tests.
- COPY/dump/restore and corrupted-type validation.
- Prepared statements with changing query parameters.
- Storage/TOAST measurements: prepared value size vs raw text.
- Benchmark raw `text` vs prepared column on 13k/183k rows.

### Exit criteria

- Identical results for raw and prepared inputs.
- Prepared scan measurably faster than raw input for ranked searches.
- Type I/O is safe and dump/restore works.

---

## 6. Phase 4 — Performance hardening and PostgreSQL integration

### Objective

Make the extension fast and predictable without indexes.

### Work items

1. **ASCII fast path**
   - Avoid UTF-16 allocation for ASCII targets/queries.
   - Lowercase/remap ASCII on the fly for `fuzzy_match`.
   - Convert to UTF-16 only when non-ASCII/remap complexity requires it.

2. **Deferred target work in `fuzzy_score`**
   - Run a cheap normalized prefilter first.
   - Build beginnings and run the full scorer only after a match is possible.

3. **Threshold ceiling pruning**
   - Compute `scoreCeiling(queryLen,targetLen)` before full scoring for non-space
     queries.
   - Reject targets that cannot reach `min_score`.
   - For space queries, derive a safe bound or skip pruning until proven.

4. **Scratch reuse**
   - Reuse per-query scratch arrays from `fn_extra`; no per-row `palloc` in the
     hot path.
   - Keep all state backend-local and parallel-worker safe.

5. **Parallelism**
   - Verify `PARALLEL SAFE` and test forced parallel plans.
   - Measure 1/4/8 workers.

6. **Memory/safety**
   - ASAN/UBSAN in CI.
   - LibFuzzer harness around the pure core.
   - Long-target and adversarial-backtracking tests.

7. **Benchmark suite**
   - 13,164 UE4 strings.
   - 182,964 Steam titles.
   - 1M synthetic titles.
   - Long descriptions for threshold pruning.
   - Queries: `e`, `el`, `eld`, `render`, `rtrgt`, `mrender.h`, `nnnne`,
     `prrun`, `straw berry`, no-match queries.
   - Variants: raw vs prepared, `fuzzy_match` vs `fuzzy_score`, threshold
     `0/.5/.8`, parallel on/off, cold/warm cache.
   - Record `EXPLAIN (ANALYZE, BUFFERS)`, `pgbench`, and `perf` profiles.

### Suggested targets (validate, do not promise)

- 13k rows: single-digit milliseconds per query.
- 183k rows: tens of milliseconds per core for common-letter queries.
- 1M rows: sub-second per core, scaling with parallel workers.
- Prepared scans within ~2x of the raw C matcher throughput.

### Exit criteria

- Benchmarks recorded and reproducible with a script.
- No memory growth over repeated queries.
- Parallel plans scale.
- Documented guidance: prepared column for repeated ranked search; no index
  required for the supported scale.

---

## 7. Phase 5 — Optional work and release

These are deferred unless the earlier phases show a need:

- **Optional lossy index.** A character-presence GIN signature (`int4[]` +
  built-in `@>` with exact recheck) or a GiST signature opclass. It cannot prune
  common short typeahead queries well; only keep it if benchmarks win.
- **Custom index AM.** A positional inverted index/subsequence verifier is a
  research project, not part of the first release.
- **Multi-key parity.** A separate `fuzzy_score_keys(query, VARIADIC targets)`
  implementing fuzzysort's `keys`/part-winner scoring. `GREATEST` is only an
  approximation for space queries.
- **Highlight/index API.** `fuzzy_indexes()` and highlighting if consumers need
  it. Indexes are UTF-16 offsets; SQL highlighting needs careful conversion.
- **Custom remap mappings.** Runtime `fuzzysort.remap()` equivalent; would make
  functions `STABLE` rather than `IMMUTABLE` unless configured at startup.
- **Packaging.** CI matrix (PG 16/17/18 if desired, even though the target is
  17), extension upgrade scripts, release tarball, README examples, license
  notices.

---

## 8. Cross-phase testing strategy

### Reference contract

Pin fuzzysort `v4.0.2` / commit `ac4d42e...`. Phase 1 uses the local clone
directly. Later CI should vendor or pin the reference so tests are
self-contained.

### Layer isolation

Test each layer independently:

1. normalization vs JS `remapChars().trim().toLowerCase()`;
2. beginnings vs JS `scanBeginnings`;
3. boolean match vs fuzzysort's match set;
4. raw score vs `result._score`;
5. normalized score vs `result.score`;
6. indexes vs sorted `result.indexes`;
7. SQL API vs the C core.

This makes mismatches diagnosable instead of treating the whole matcher as a
black box.

### Corpus

- fuzzysort's full test suite cases.
- All BMP code units for normalization/beginnings.
- UE4 full dataset, Steam sampled and later full, Pokémon, URLs, movie quotes,
  emoji.
- Deterministic random targets/queries with fixed seeds.
- Long targets around `UINT16_MAX`.
- Adversarial backtracking cases.
- Empty, whitespace-only, NULL, and invalid-UTF-8 SQL inputs.

### Ordering parity

Because PostgreSQL does the sorting:

- compare per-target scores;
- for every pair with expected score difference > epsilon, require the same
  order;
- use `ORDER BY score DESC NULLS LAST, id` for deterministic ties;
- compare top-K sets, not fuzzysort's heap tie order.

### Performance correctness

- Every performance optimization must be verified against the unoptimized
  reference results.
- Threshold pruning must never reject a match that should pass.
- Prepared vs raw must be identical.

---

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| fuzzysort's scoring has subtle branches | Port line-by-line, keep raw-score tests separate from normalized-score tests |
| Unicode version drift | Pin Node/Unicode reference; generate tables with `tools/gen_tables.mjs` |
| JS UTF-16 vs PostgreSQL UTF-8 | Internal UTF-16 representation; ASCII fast path later |
| Floating-point ordering differences | Same operation order, no fast-math/FMA contraction, tolerance in tests |
| Long-target integer overflow | Score arithmetic uses `double`; Phase 1 tested up to 65,536; add larger tests |
| Prepared value format changes | Magic/version header; generated columns; upgrade scripts |
| No good subsequence index | Accept parallel sequential scan; optional lossy signature only if benchmarks justify |
| Planner evaluates score twice | Document the `LATERAL` pattern |
| `DESC` NULL ordering surprise | Document `NULLS LAST` |
| Memory bloat / leaks | Per-query memory contexts, scratch reuse, RSS tests, ASAN/fuzzing |
| Extension evaluated with non-UTF-8 database | Explicit error in SQL glue |

---

## 10. Progress log

| Phase | Status | Notes |
|---|---|---|
| Phase 1 — pure C core + fuzzysort parity | **Complete** | 257,820/257,820 score cases passed; normalization/beginnings 100% |
| Phase 2 — PG17 extension shell + raw SQL functions | **Complete** | SQL API, query cache, 7,442 score cases, 63,487 normalization cases, non-UTF-8 rejection |
| Phase 3 — prepared target type + overloads | Not started | Next |
| Phase 4 — performance hardening + benchmarks | Not started | |
| Phase 5 — optional indexes/multi-key/release | Not started | |

---

## 11. Commands

From `pg_fuzzysearch_dsf41/`:

```sh
make                 # build the standalone C core + parity CLI
make test-phase1     # run the fuzzysort differential harness
make pg              # build the PostgreSQL extension (.so)
make test-phase2     # start a temp PG17 cluster and run SQL parity tests
make pg-install      # install the extension (requires write access to PG dirs)
make tables          # regenerate src/tables.c/.h from Node
make clean
```

For a non-root packaging check:

```sh
make -C pg install DESTDIR=/tmp/pg_fuzzy_install
```

`make installcheck` / `pg_regress` will be added when CI can install the
extension into the real PostgreSQL extension directory.
