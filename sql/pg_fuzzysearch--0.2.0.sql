-- pg_fuzzysearch extension, version 0.2.0
-- Phase 3: prepared fuzzy_target values.

\echo Use "CREATE EXTENSION pg_fuzzysearch" to load this file. \quit

CREATE FUNCTION fuzzy_match(query text, target text)
RETURNS boolean
AS 'MODULE_PATHNAME', 'pg_fuzzy_match'
LANGUAGE C STRICT IMMUTABLE PARALLEL SAFE;

COMMENT ON FUNCTION fuzzy_match(text, text) IS
'True when the normalized query is a fuzzysort subsequence match. Use fuzzy_match(query, target, 0.5) for the fuzzysort default quality filter.';

CREATE FUNCTION fuzzy_match(query text, target text, min_score double precision)
RETURNS boolean
AS 'MODULE_PATHNAME', 'pg_fuzzy_match'
LANGUAGE C STRICT IMMUTABLE PARALLEL SAFE;

COMMENT ON FUNCTION fuzzy_match(text, text, double precision) IS
'True when the normalized fuzzysort score is at least min_score. min_score 0 accepts any match; 0.5 mirrors fuzzysort defaults.';

CREATE FUNCTION fuzzy_score(query text, target text)
RETURNS double precision
AS 'MODULE_PATHNAME', 'pg_fuzzy_score'
LANGUAGE C STRICT IMMUTABLE PARALLEL SAFE;

COMMENT ON FUNCTION fuzzy_score(text, text) IS
'Normalized fuzzysort score in (0,1], NULL when there is no match, 0 for an empty or effectively-empty query.';

CREATE FUNCTION fuzzy_normalize(value text)
RETURNS text
AS 'MODULE_PATHNAME', 'pg_fuzzy_normalize'
LANGUAGE C STRICT IMMUTABLE PARALLEL SAFE;

COMMENT ON FUNCTION fuzzy_normalize(text) IS
'Diagnostic helper: target-style normalization (remap and lowercase, no trim).';

CREATE FUNCTION fuzzy_normalize_query(value text)
RETURNS text
AS 'MODULE_PATHNAME', 'pg_fuzzy_normalize_query'
LANGUAGE C STRICT IMMUTABLE PARALLEL SAFE;

COMMENT ON FUNCTION fuzzy_normalize_query(text) IS
'Diagnostic helper: query-style normalization (remap, trim, lowercase).';

-- Prepared targets ---------------------------------------------------------

CREATE TYPE fuzzy_target;

CREATE FUNCTION fuzzy_target_in(cstring)
RETURNS fuzzy_target
AS 'MODULE_PATHNAME', 'fuzzy_target_in'
LANGUAGE C STRICT IMMUTABLE PARALLEL SAFE;

CREATE FUNCTION fuzzy_target_out(fuzzy_target)
RETURNS cstring
AS 'MODULE_PATHNAME', 'fuzzy_target_out'
LANGUAGE C STRICT IMMUTABLE PARALLEL SAFE;

CREATE FUNCTION fuzzy_target_recv(internal)
RETURNS fuzzy_target
AS 'MODULE_PATHNAME', 'fuzzy_target_recv'
LANGUAGE C STRICT IMMUTABLE PARALLEL SAFE;

CREATE FUNCTION fuzzy_target_send(fuzzy_target)
RETURNS bytea
AS 'MODULE_PATHNAME', 'fuzzy_target_send'
LANGUAGE C STRICT IMMUTABLE PARALLEL SAFE;

CREATE TYPE fuzzy_target (
    INPUT = fuzzy_target_in,
    OUTPUT = fuzzy_target_out,
    RECEIVE = fuzzy_target_recv,
    SEND = fuzzy_target_send,
    INTERNALLENGTH = VARIABLE,
    STORAGE = EXTENDED,
    ALIGNMENT = int4
);

COMMENT ON TYPE fuzzy_target IS
'Immutable prepared target for pg_fuzzysearch. Create with fuzzy_prepare(text).';

CREATE FUNCTION fuzzy_prepare(target text)
RETURNS fuzzy_target
AS 'MODULE_PATHNAME', 'pg_fuzzy_prepare'
LANGUAGE C STRICT IMMUTABLE PARALLEL SAFE;

COMMENT ON FUNCTION fuzzy_prepare(text) IS
'Prepare a target for repeated fuzzy searches. Prefer a stored generated column.';

CREATE FUNCTION fuzzy_match(query text, target fuzzy_target)
RETURNS boolean
AS 'MODULE_PATHNAME', 'pg_fuzzy_match_prepared'
LANGUAGE C STRICT IMMUTABLE PARALLEL SAFE;

COMMENT ON FUNCTION fuzzy_match(text, fuzzy_target) IS
'Boolean match against a prepared target.';

CREATE FUNCTION fuzzy_match(query text, target fuzzy_target, min_score double precision)
RETURNS boolean
AS 'MODULE_PATHNAME', 'pg_fuzzy_match_prepared'
LANGUAGE C STRICT IMMUTABLE PARALLEL SAFE;

COMMENT ON FUNCTION fuzzy_match(text, fuzzy_target, double precision) IS
'Thresholded match against a prepared target.';

CREATE FUNCTION fuzzy_score(query text, target fuzzy_target)
RETURNS double precision
AS 'MODULE_PATHNAME', 'pg_fuzzy_score_prepared'
LANGUAGE C STRICT IMMUTABLE PARALLEL SAFE;

COMMENT ON FUNCTION fuzzy_score(text, fuzzy_target) IS
'Normalized fuzzysort score against a prepared target.';
