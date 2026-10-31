-- pg_fuzzysearch 0.1.0 -> 0.2.0
-- Adds the prepared fuzzy_target type and overloads.

\echo Use "ALTER EXTENSION pg_fuzzysearch UPDATE TO '0.2.0'" to load this file. \quit

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
