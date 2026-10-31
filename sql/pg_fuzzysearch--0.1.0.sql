-- pg_fuzzysearch extension, version 0.1.0
-- Phase 2: raw text functions. Prepared targets arrive in Phase 3.

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
