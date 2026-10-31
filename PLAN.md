# pg_fuzzysearch_dsf41 — Implementation Plan

**Status:** Phase 4 complete. Phase 5 remains.
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
│   ├── fuzzy_type.c/.h      prepared fuzzy_target varlena type (Phase 3)
│   └── pg_fuzzysearch.c     PostgreSQL C glue (Phase 2)
├── tools/
│   ├── gen_tables.mjs       regenerates src/tables.c/.h
│   └── fuzzy_cli.c          standalone parity/benchmark CLI
├── pg/
│   ├── Makefile             PGXS build
│   └── pg_fuzzysearch.control
├── sql/
│   ├── pg_fuzzysearch--0.1.0.sql
│   ├── pg_fuzzysearch--0.1.0--0.2.0.sql
│   └── pg_fuzzysearch--0.2.0.sql
└── test/
    ├── phase1/run.mjs       core differential parity harness
    ├── phase2/run.mjs       temporary-cluster SQL parity harness
    ├── phase3/
    │   ├── run.mjs          prepared-target correctness tests
    │   └── bench.mjs        raw vs prepared benchmark
    └── phase4/
        ├── run.mjs          parallel/long-input integration tests
        └── bench.mjs        full threshold/parallel/1M benchmark
```

Phase 5 is optional/documented below.

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

## 5. Phase 3 — Prepared target type (COMPLETE)

### Objective

Remove repeated target normalization and beginning construction, which is the
largest per-row cost for ranked searches.

### Prepared type (implemented)

Added the varlena type `fuzzy_target`:

```c
FuzzyTargetPayload:
  magic, format_version, bitflags, flags, target_len, beginnings_len
  first_table[26]
  beginnings[]        int32 offsets
  codes[]             uint16 UTF-16 code units
```

- `fuzzy_prepare(target text) RETURNS fuzzy_target`.
- Overloads:
  - `fuzzy_match(query text, target fuzzy_target [, min_score])`
  - `fuzzy_score(query text, target fuzzy_target)`
- Type I/O:
  - text output/input uses an `FX1:<hex>` form;
  - binary send/recv carries the payload for COPY;
  - magic/version/length/offset validation rejects corrupt values;
  - normalization-version upgrades require re-preparing stored values.
- Extension version is now `0.2.0`; `0.1.0 -- 0.2.0` upgrade script exists.
- Recommended usage:

```sql
ALTER TABLE items ADD COLUMN title_fuzzy fuzzy_target
  GENERATED ALWAYS AS (fuzzy_prepare(title)) STORED;
```

Generated columns are recomputed on dump/restore and avoid stale prepared data.

### Query cache integration

The raw-text query cache was implemented in Phase 2. The prepared-target
overloads reuse the same `fn_extra` cache and scratch buffers. Cached query bytes
are compared on every call, so generic plans with changing parameters are safe.
Per-row raw targets are never cached.

### Testing

- 2,734 raw/prepared cases from fuzzysort datasets, curated cases, and random
  inputs: match/score equality, prepared threshold behavior, and text I/O
  round-trips.
- Generated-column insert/update tests.
- Text output/input and binary COPY round-trips, including Unicode and empty
  targets.
- Corrupt `FX1:` payload and invalid input syntax rejection.
- `0.1.0 -> 0.2.0` upgrade script test.
- Raw-vs-prepared benchmark on UE4 and Steam.

### Phase 3 results

`make test-phase3`:

```
prepared target cases: 2734
prepared cases: 2734/2734 passed
type I/O and API: passed
binary COPY round-trip: passed
generated prepared column: passed
0.1.0 -> 0.2.0 upgrade: passed
PHASE 3 PREPARED-TARGET TESTS PASSED
```

`make bench-phase3` (PostgreSQL 17.11, single core, warm cache, median of 3):

Relation sizes:

```
ue4   13,164 rows   3,632 kB   title avg 23.1 B    prepared avg 197.1 B
steam 182,964 rows  49 MB      title avg 26.5 B    prepared avg 214.3 B
```

Match-only, threshold 0.5:

| table | query | raw ms | prepared ms | speedup |
|---|---|---|---|---|
| ue4 | e | 5.49 | 3.54 | 1.55x |
| ue4 | el | 5.40 | 4.08 | 1.32x |
| ue4 | eld | 5.58 | 3.78 | 1.48x |
| ue4 | render | 5.26 | 3.33 | 1.58x |
| ue4 | rtrgt | 6.08 | 3.17 | 1.92x |
| steam | e | 39.94 | 22.23 | 1.80x |
| steam | el | 39.46 | 23.01 | 1.71x |
| steam | eld | 41.87 | 23.42 | 1.79x |
| steam | render | 38.01 | 22.60 | 1.68x |

Ordered top-10 was 1.4x–1.8x faster with prepared targets.

### Phase 3 known limitations

- Prepared values are UTF-16 only; average storage is roughly 8x the raw title
  for the tested datasets. Phase 4 will add an ASCII representation.
- `first_table` is stored but not yet used by a dedicated single-character
  algorithm.
- The current prepared representation does not define equality operators; tests
  compare output/input and scores instead.

### Phase 3 exit criteria — met

- Identical results for raw and prepared inputs — met.
- Prepared scan is measurably faster — 1.3x–1.9x on the benchmark.
- Type I/O and binary COPY are safe — met.
- Upgrade script works — met.

---

## 6. Phase 4 — Performance hardening and PostgreSQL integration (COMPLETE)

### Objective

Make the extension fast and predictable without indexes.

### Implemented work

1. **ASCII fast path**
   - Core targets now use either `uint8` ASCII codes or `uint16` UTF-16 codes.
   - Prepared `fuzzy_target` format v2 stores ASCII targets compactly.
   - Version 1 prepared payloads remain readable for backward compatibility.
   - Raw `text` searches use an allocation-free ASCII prefilter for non-space
     queries; non-ASCII targets fall back to full preparation.

2. **Deferred target work**
   - `fuzzy_score(text,text)` returns NULL before target preparation when the
     ASCII prefilter proves there is no match.
   - `fuzzy_match(text,text)` can answer ASCII matches/non-matches without
     building a target at all.
   - `fuzzy_match(..., min_score)` can reject no-match ASCII targets before
     preparation.

3. **Threshold ceiling pruning**
   - Added `fuzzy_match_threshold_view` / `fuzzy_match_threshold`.
   - Non-space threshold queries use `scoreCeiling` before the greedy scan.
   - Exact-threshold matches are preserved (`<` cutoff, not `<=`).
   - Space queries fall back to full scoring.
   - Threshold parity tested at `0`, `.1`, `.3`, `.5`, `.8`, `1.0`, including
     long targets.

4. **Scratch reuse**
   - Query/scratch state is reused through `fn_extra` and reset callbacks.
   - No per-row palloc in prepared scoring paths.

5. **Parallelism**
   - Forced parallel plans verified with 2/4/8 workers.
   - Serial and parallel result counts match.
   - Prepared scans scale across workers.

6. **Memory/safety**
   - Long/adversarial backtracking inputs run under statement timeouts.
   - Repeated prepared scans (100 iterations) complete without errors.
   - ASAN/Valgrind are unavailable on this machine (`libasan` missing);
     CI sanitizer coverage remains a release task.

7. **Benchmark suite**
   - `test/phase4/bench.mjs` covers UE4, Steam, 1M synthetic rows, long
     descriptions, thresholds, raw vs prepared, ordered top-10, and parallel
     scans.
   - `test/phase4/run.mjs` covers parallel plans, adversarial inputs, and
     repeated scans.

### Phase 4 results

Correctness:

```
PHASE 1 PARITY PASSED
PHASE 2 SQL PARITY PASSED
PHASE 3 PREPARED-TARGET TESTS PASSED
parallel plan: 4 workers
PHASE 4 INTEGRATION TESTS PASSED
```

Prepared storage after v2 ASCII representation:

| table | rows | raw avg | prepared avg |
|---|---:|---:|---:|
| UE4 | 13,164 | 23.1 B | 64.0 B |
| Steam | 182,964 | 26.5 B | 80.5 B |
| 1M synthetic | 1,000,000 | 77.9 B | 125.9 B |

The compact format reduced prepared storage from roughly 197–214 B to 64–81 B
for the title datasets.

Prepared threshold matrix, 1M synthetic titles (median ms):

| query | threshold 0 | .5 | .8 |
|---|---:|---:|---:|
| render | 69.91 | 103.14 | 83.02 |
| item | 79.72 | 117.51 | 83.48 |
| zzzzzz | 70.67 | 102.97 | 83.21 |

Raw vs prepared, threshold `.5` highlights:

| table | query | raw ms | prepared ms | speedup |
|---|---|---:|---:|---:|
| UE4 | e | 5.83 | 2.81 | 2.08x |
| Steam | e | 41.62 | 21.25 | 1.96x |
| Steam | render | 20.79 | 20.21 | 1.03x |
| 1M synthetic | item | 456.59 | 118.79 | 3.84x |
| long descriptions | the | 54.12 | 31.01 | 1.75x |

For very selective queries such as UE4 `render`/`rtrgt`, the raw ASCII
prefilter can be faster than reading prepared values; the extension now makes
that tradeoff explicit rather than assuming prepared is always faster.

Parallel prepared scan, 1M synthetic, query `render`, threshold `.5`:

| workers | execution ms |
|---|---:|
| 0 | 232.91 |
| 2 | 104.69 |
| 4 | 74.30 |
| 8 | 64.27 |

The 0-worker absolute time was affected by cache pressure from the mixed
benchmark; the scaling trend is the important result. Isolated warm prepared
scans were ~103 ms.

### Phase 4 known limitations

- ASAN/UBSAN/libFuzzer runs are not possible in this environment.
- Parallel absolute timings vary with shared-buffer/cache state; the script is
  reproducible but should be run on dedicated hardware for release numbers.
- No index is used; this remains intentional for the first release.
- Multi-key/object scoring and highlighting remain Phase 5.

### Phase 4 exit criteria — met

- Benchmarks recorded and reproducible with `make bench-phase4`.
- Parallel plans verified and scale.
- Repeated scans stable.
- Prepared values are compact enough for practical use.
- Guidance documented: use prepared columns for repeated ranked searches; no
  index is required at the supported scale.

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
| Phase 3 — prepared target type + overloads | **Complete** | `fuzzy_target`, type I/O, generated columns, upgrade script, 2,734 prepared cases, 1.3x–1.9x speedup |
| Phase 4 — performance hardening + benchmarks | **Complete** | ASCII v2 payload, raw prefilter, threshold pruning, parallel scaling, 1M benchmark |
| Phase 5 — optional indexes/multi-key/release | Not started | Optional/release |

---

## 11. Commands

From `pg_fuzzysearch_dsf41/`:

```sh
make                 # build the standalone C core + parity CLI
make test-phase1     # run the fuzzysort differential harness
make pg              # build the PostgreSQL extension (.so)
make test-phase2     # start a temp PG17 cluster and run SQL parity tests
make test-phase3     # prepared target correctness tests
make test-phase4     # parallel/long-input integration tests
make bench-phase3    # raw-vs-prepared UE4/Steam benchmark
make bench-phase4    # threshold/parallel/1M benchmark
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
