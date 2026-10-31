#include "postgres.h"

#include <math.h>
#include <string.h>

#include "fmgr.h"
#include "mb/pg_wchar.h"
#include "utils/builtins.h"
#include "utils/memutils.h"
#include "varatt.h"

#include "fuzzy_core.h"
#include "fuzzy_type.h"

PG_MODULE_MAGIC;

/*
 * Per-call-node cache.  The normalized query is constant for most statements,
 * so prepare it once instead of once per row.  Everything is owned by the
 * function's memory context and released by the reset callback.
 */
typedef struct FuzzyCache
{
    FmgrInfo   *flinfo;
    MemoryContext mcxt;
    char       *query_copy;
    Size        query_len;
    FuzzyQuery *query;
    FuzzyScratch *scratch;
} FuzzyCache;

static void
fuzzy_cache_reset(void *arg)
{
    FuzzyCache *cache = (FuzzyCache *) arg;

    if (cache->flinfo != NULL && cache->flinfo->fn_extra == cache)
        cache->flinfo->fn_extra = NULL;

    fuzzy_query_free(cache->query);
    fuzzy_scratch_free(cache->scratch);
    cache->query = NULL;
    cache->scratch = NULL;
    cache->query_copy = NULL;
    cache->query_len = 0;
}

static FuzzyCache *
fuzzy_get_cache(FunctionCallInfo fcinfo)
{
    FuzzyCache *cache = (FuzzyCache *) fcinfo->flinfo->fn_extra;
    MemoryContextCallback *callback;

    if (cache != NULL)
        return cache;

    cache = (FuzzyCache *) MemoryContextAllocZero(fcinfo->flinfo->fn_mcxt,
                                                  sizeof(FuzzyCache));
    cache->flinfo = fcinfo->flinfo;
    cache->mcxt = fcinfo->flinfo->fn_mcxt;

    callback = (MemoryContextCallback *)
        MemoryContextAlloc(fcinfo->flinfo->fn_mcxt,
                           sizeof(MemoryContextCallback));
    callback->func = fuzzy_cache_reset;
    callback->arg = cache;
    MemoryContextRegisterResetCallback(fcinfo->flinfo->fn_mcxt, callback);

    fcinfo->flinfo->fn_extra = cache;
    return cache;
}

static void
fuzzy_require_utf8(void)
{
    if (GetDatabaseEncoding() != PG_UTF8)
        ereport(ERROR,
                (errcode(ERRCODE_FEATURE_NOT_SUPPORTED),
                 errmsg("pg_fuzzysearch requires a UTF-8 database"),
                 errdetail("The current database encoding is %s.",
                           GetDatabaseEncodingName())));
}

static FuzzyQuery *
fuzzy_get_query(FuzzyCache *cache, text *query_text)
{
    const char *data = VARDATA_ANY(query_text);
    Size        len = (Size) VARSIZE_ANY_EXHDR(query_text);

    if (cache->query != NULL &&
        cache->query_len == len &&
        memcmp(cache->query_copy, data, len) == 0)
        return cache->query;

    fuzzy_query_free(cache->query);
    cache->query = NULL;
    if (cache->query_copy != NULL)
    {
        pfree(cache->query_copy);
        cache->query_copy = NULL;
    }
    cache->query_len = 0;

    cache->query_copy = (char *) MemoryContextAlloc(cache->mcxt,
                                                    len > 0 ? len : 1);
    if (len > 0)
        memcpy(cache->query_copy, data, len);

    cache->query = fuzzy_query_prepare(data, (size_t) len);
    if (cache->query == NULL)
        ereport(ERROR,
                (errcode(ERRCODE_OUT_OF_MEMORY),
                 errmsg("pg_fuzzysearch: could not prepare query")));

    cache->query_len = len;
    return cache->query;
}

static FuzzyTarget *
fuzzy_get_target(text *target_text)
{
    FuzzyTarget *target;

    target = fuzzy_target_prepare(VARDATA_ANY(target_text),
                                  (size_t) VARSIZE_ANY_EXHDR(target_text));
    if (target == NULL)
        ereport(ERROR,
                (errcode(ERRCODE_OUT_OF_MEMORY),
                 errmsg("pg_fuzzysearch: could not prepare target")));
    return target;
}

static void
fuzzy_get_prepared_view(FunctionCallInfo fcinfo, int argno,
                        FuzzyTargetView *view)
{
    struct varlena *value = PG_GETARG_VARLENA_P(argno);

    fuzzy_target_payload_view((const FuzzyTargetPayload *) VARDATA(value),
                              VARSIZE(value) - VARHDRSZ, view);
}

static void
fuzzy_check_scratch(FuzzyScratch *scratch, FuzzyTarget *target)
{
    if (fuzzy_scratch_oom(scratch))
    {
        fuzzy_target_free(target);
        ereport(ERROR,
                (errcode(ERRCODE_OUT_OF_MEMORY),
                 errmsg("pg_fuzzysearch: out of memory")));
    }
}

static FuzzyScratch *
fuzzy_get_scratch(FuzzyCache *cache)
{
    if (cache->scratch == NULL)
    {
        cache->scratch = fuzzy_scratch_new();
        if (cache->scratch == NULL)
            ereport(ERROR,
                    (errcode(ERRCODE_OUT_OF_MEMORY),
                     errmsg("pg_fuzzysearch: out of memory")));
    }
    return cache->scratch;
}

PG_FUNCTION_INFO_V1(pg_fuzzy_match);
PG_FUNCTION_INFO_V1(pg_fuzzy_score);
PG_FUNCTION_INFO_V1(pg_fuzzy_match_prepared);
PG_FUNCTION_INFO_V1(pg_fuzzy_score_prepared);
PG_FUNCTION_INFO_V1(pg_fuzzy_normalize);
PG_FUNCTION_INFO_V1(pg_fuzzy_normalize_query);

Datum
pg_fuzzy_match(PG_FUNCTION_ARGS)
{
    FuzzyCache *cache;
    FuzzyQuery *query;
    FuzzyTarget *target = NULL;
    text       *target_text = PG_GETARG_TEXT_PP(1);
    bool        matched;

    fuzzy_require_utf8();
    cache = fuzzy_get_cache(fcinfo);
    query = fuzzy_get_query(cache, PG_GETARG_TEXT_PP(0));

    if (PG_NARGS() == 2)
    {
        int         early = fuzzy_match_ascii_bytes(query,
                                                    VARDATA_ANY(target_text),
                                                    (size_t) VARSIZE_ANY_EXHDR(target_text));

        if (early >= 0)
            matched = early == 1;
        else
        {
            target = fuzzy_get_target(target_text);
            matched = fuzzy_match_bool(query, target);
            fuzzy_target_free(target);
            target = NULL;
        }
    }
    else
    {
        FuzzyScratch *scratch = fuzzy_get_scratch(cache);
        double      min_score = PG_GETARG_FLOAT8(2);
        int         early;

        if (isnan(min_score))
            ereport(ERROR,
                    (errcode(ERRCODE_INVALID_PARAMETER_VALUE),
                     errmsg("pg_fuzzysearch: min_score must not be NaN")));

        early = fuzzy_match_ascii_bytes(query, VARDATA_ANY(target_text),
                                        (size_t) VARSIZE_ANY_EXHDR(target_text));
        if (early == 0)
            matched = false;
        else if (early == 1 && min_score <= 0)
            matched = true;
        else if (min_score > 1)
            matched = false;
        else
        {
            target = fuzzy_get_target(target_text);
            matched = fuzzy_match_threshold(query, target, min_score, scratch);
            fuzzy_check_scratch(scratch, target);
            fuzzy_target_free(target);
            target = NULL;
        }
    }

    PG_RETURN_BOOL(matched);
}

Datum
pg_fuzzy_score(PG_FUNCTION_ARGS)
{
    FuzzyCache *cache;
    FuzzyQuery *query;
    FuzzyTarget *target;
    FuzzyScratch *scratch;
    FuzzyResult result;
    bool        matched;
    text       *target_text = PG_GETARG_TEXT_PP(1);
    int         early;

    fuzzy_require_utf8();
    cache = fuzzy_get_cache(fcinfo);
    query = fuzzy_get_query(cache, PG_GETARG_TEXT_PP(0));
    early = fuzzy_match_ascii_bytes(query, VARDATA_ANY(target_text),
                                    (size_t) VARSIZE_ANY_EXHDR(target_text));
    if (early == 0)
        PG_RETURN_NULL();

    scratch = fuzzy_get_scratch(cache);
    target = fuzzy_get_target(target_text);

    matched = fuzzy_score(query, target, scratch, &result);
    fuzzy_check_scratch(scratch, target);
    fuzzy_target_free(target);

    if (!matched)
        PG_RETURN_NULL();

    PG_RETURN_FLOAT8(result.score);
}

Datum
pg_fuzzy_match_prepared(PG_FUNCTION_ARGS)
{
    FuzzyCache *cache;
    FuzzyQuery *query;
    FuzzyTargetView target;
    bool        matched;

    fuzzy_require_utf8();
    cache = fuzzy_get_cache(fcinfo);
    query = fuzzy_get_query(cache, PG_GETARG_TEXT_PP(0));
    fuzzy_get_prepared_view(fcinfo, 1, &target);

    if (PG_NARGS() == 2)
    {
        matched = fuzzy_match_bool_view(query, &target);
    }
    else
    {
        FuzzyScratch *scratch = fuzzy_get_scratch(cache);
        double      min_score = PG_GETARG_FLOAT8(2);

        if (isnan(min_score))
            ereport(ERROR,
                    (errcode(ERRCODE_INVALID_PARAMETER_VALUE),
                     errmsg("pg_fuzzysearch: min_score must not be NaN")));

        matched = fuzzy_match_threshold_view(query, &target, min_score, scratch);
        fuzzy_check_scratch(scratch, NULL);
    }

    PG_RETURN_BOOL(matched);
}

Datum
pg_fuzzy_score_prepared(PG_FUNCTION_ARGS)
{
    FuzzyCache *cache;
    FuzzyQuery *query;
    FuzzyTargetView target;
    FuzzyScratch *scratch;
    FuzzyResult result;
    bool        matched;

    fuzzy_require_utf8();
    cache = fuzzy_get_cache(fcinfo);
    query = fuzzy_get_query(cache, PG_GETARG_TEXT_PP(0));
    fuzzy_get_prepared_view(fcinfo, 1, &target);
    scratch = fuzzy_get_scratch(cache);

    matched = fuzzy_score_view(query, &target, scratch, &result);
    fuzzy_check_scratch(scratch, NULL);

    if (!matched)
        PG_RETURN_NULL();

    PG_RETURN_FLOAT8(result.score);
}

Datum
pg_fuzzy_normalize(PG_FUNCTION_ARGS)
{
    text       *value = PG_GETARG_TEXT_PP(0);
    char       *normalized;
    size_t      normalized_len;
    text       *result;

    fuzzy_require_utf8();
    normalized = fuzzy_debug_target_normalize(VARDATA_ANY(value),
                                              (size_t) VARSIZE_ANY_EXHDR(value),
                                              &normalized_len);
    if (normalized == NULL)
        ereport(ERROR,
                (errcode(ERRCODE_OUT_OF_MEMORY),
                 errmsg("pg_fuzzysearch: could not normalize value")));

    result = cstring_to_text_with_len(normalized, (int) normalized_len);
    free(normalized);
    PG_RETURN_TEXT_P(result);
}

Datum
pg_fuzzy_normalize_query(PG_FUNCTION_ARGS)
{
    text       *value = PG_GETARG_TEXT_PP(0);
    char       *normalized;
    size_t      normalized_len;
    text       *result;

    fuzzy_require_utf8();
    normalized = fuzzy_debug_query_normalize(VARDATA_ANY(value),
                                             (size_t) VARSIZE_ANY_EXHDR(value),
                                             &normalized_len);
    if (normalized == NULL)
        ereport(ERROR,
                (errcode(ERRCODE_OUT_OF_MEMORY),
                 errmsg("pg_fuzzysearch: could not normalize query")));

    result = cstring_to_text_with_len(normalized, (int) normalized_len);
    free(normalized);
    PG_RETURN_TEXT_P(result);
}
