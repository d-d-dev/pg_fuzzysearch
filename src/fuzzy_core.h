#ifndef FUZZY_CORE_H
#define FUZZY_CORE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct FuzzyQuery FuzzyQuery;
typedef struct FuzzyTarget FuzzyTarget;

typedef struct FuzzyScratch FuzzyScratch;

bool fuzzy_scratch_oom(const FuzzyScratch *scratch);

typedef struct {
    bool matched;
    double raw_score;
    double score;
    int *indexes;       /* valid until the next fuzzy_score() on this scratch */
    int index_count;
} FuzzyResult;

/* Prepare a query/target from valid UTF-8.  Returns NULL on invalid UTF-8 or
 * allocation failure.  Empty input is valid. */
FuzzyQuery *fuzzy_query_prepare(const char *input, size_t len);
FuzzyTarget *fuzzy_target_prepare(const char *input, size_t len);
void fuzzy_query_free(FuzzyQuery *query);
void fuzzy_target_free(FuzzyTarget *target);

FuzzyScratch *fuzzy_scratch_new(void);
bool fuzzy_scratch_reserve(FuzzyScratch *scratch, int query_len, int nparts,
                           int target_len);
void fuzzy_scratch_free(FuzzyScratch *scratch);

/* Fast boolean-only search.  Empty/effectively-empty queries match every
 * target, with score 0 in the scoring API. */
bool fuzzy_match_bool(const FuzzyQuery *query, const FuzzyTarget *target);

/* Full fuzzysort-compatible scoring.  Returns true when the query matches.
 * An empty/effectively-empty query matches with raw_score=-Inf and score=0. */
bool fuzzy_score(const FuzzyQuery *query, const FuzzyTarget *target,
                 FuzzyScratch *scratch, FuzzyResult *result);

/* Debug/parity helpers.  Returned strings are malloc'd UTF-8. */
char *fuzzy_debug_query_normalize(const char *input, size_t len, size_t *out_len);
char *fuzzy_debug_target_normalize(const char *input, size_t len, size_t *out_len);
bool fuzzy_debug_target_beginnings(const char *input, size_t len,
                                   int **out, int *out_count);

#endif
