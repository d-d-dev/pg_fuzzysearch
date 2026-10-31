#include "fuzzy_core.h"
#include "normalize.h"
#include "tables.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

#define FUZZY_E 2.71828182845904523536028747135266249775724709369995
#define FUZZY_INF INFINITY

typedef struct {
    int len;
    uint16_t *codes;      /* owned for queries/targets */
    uint32_t bitflags;
    bool has_space;
} FuzzySearch;

struct FuzzyQuery {
    bool empty;
    FuzzySearch full;
    int nparts;
    FuzzySearch *parts;
};

struct FuzzyTarget {
    uint16_t *codes;
    int *beginnings;
    int first_table[26];
    FuzzyTargetView view;
};

struct FuzzyScratch {
    int *simple;
    int simple_cap;
    int *strict;
    int strict_cap;
    int *out;
    int out_cap;
    int *seen;
    int seen_cap;
    unsigned int *seen_at;
    int seen_at_cap;
    int *next;
    int next_cap;
    int *result;
    int result_cap;
    unsigned int generation;
    bool oom;
};

typedef struct {
    double score;
    int *indexes;
    int len;
} AlgResult;

static bool int_reserve(int **ptr, int *cap, int need)
{
    if (need < 1)
        need = 1;
    if (*cap >= need)
        return true;

    int *grown = realloc(*ptr, (size_t) need * sizeof(int));
    if (grown == NULL)
        return false;
    *ptr = grown;
    *cap = need;
    return true;
}

static bool seen_at_reserve(FuzzyScratch *s, int need)
{
    if (need < 1)
        need = 1;
    if (s->seen_at_cap >= need)
        return true;

    unsigned int *grown = realloc(s->seen_at, (size_t) need * sizeof(unsigned int));
    if (grown == NULL)
        return false;
    memset(grown + s->seen_at_cap, 0,
           (size_t) (need - s->seen_at_cap) * sizeof(unsigned int));
    s->seen_at = grown;
    s->seen_at_cap = need;
    return true;
}

FuzzyScratch *fuzzy_scratch_new(void)
{
    return calloc(1, sizeof(FuzzyScratch));
}

bool fuzzy_scratch_oom(const FuzzyScratch *scratch)
{
    return scratch != NULL && scratch->oom;
}

bool fuzzy_scratch_reserve(FuzzyScratch *s, int query_len, int nparts,
                           int target_len)
{
    (void) nparts;
    if (query_len < 1)
        query_len = 1;
    if (target_len < 1)
        target_len = 1;

    if (!int_reserve(&s->simple, &s->simple_cap, query_len))
        return false;
    if (!int_reserve(&s->strict, &s->strict_cap, query_len))
        return false;
    if (!int_reserve(&s->out, &s->out_cap, query_len))
        return false;
    if (!int_reserve(&s->seen, &s->seen_cap, target_len))
        return false;
    if (!seen_at_reserve(s, target_len))
        return false;
    if (!int_reserve(&s->next, &s->next_cap, target_len))
        return false;
    if (!int_reserve(&s->result, &s->result_cap, target_len))
        return false;
    return true;
}

void fuzzy_scratch_free(FuzzyScratch *s)
{
    if (s == NULL)
        return;
    free(s->simple);
    free(s->strict);
    free(s->out);
    free(s->seen);
    free(s->seen_at);
    free(s->next);
    free(s->result);
    free(s);
}

static void search_free(FuzzySearch *s)
{
    free(s->codes);
    s->codes = NULL;
}

static bool prepare_search_from_lower(uint16_t *lower, size_t lower_len,
                                      FuzzySearch *out)
{
    uint32_t flags;
    bool has_space;

    fuzzy_bitflags(lower, lower_len, &flags, &has_space);
    out->len = (int) lower_len;
    out->codes = lower;
    out->bitflags = flags;
    out->has_space = has_space;
    return true;
}

static int compare_codes(const uint16_t *a, int alen, const uint16_t *b, int blen)
{
    if (alen != blen)
        return alen < blen ? -1 : 1;
    return memcmp(a, b, (size_t) alen * sizeof(uint16_t));
}

static bool query_add_part(FuzzyQuery *query, int *part_cap,
                           const uint16_t *codes, int len)
{
    if (len <= 0)
        return true;

    for (int i = 0; i < query->nparts; i++) {
        if (compare_codes(query->parts[i].codes, query->parts[i].len,
                          codes, len) == 0)
            return true;
    }

    if (query->nparts == *part_cap) {
        int new_cap = *part_cap ? *part_cap * 2 : 8;
        FuzzySearch *grown = realloc(query->parts,
                                     (size_t) new_cap * sizeof(FuzzySearch));
        if (grown == NULL)
            return false;
        query->parts = grown;
        *part_cap = new_cap;
    }

    uint16_t *copy = malloc((size_t) len * sizeof(uint16_t));
    if (copy == NULL)
        return false;
    memcpy(copy, codes, (size_t) len * sizeof(uint16_t));

    FuzzySearch *part = &query->parts[query->nparts++];
    part->len = len;
    part->codes = copy;
    part->has_space = false;
    fuzzy_bitflags(copy, (size_t) len, &part->bitflags, &part->has_space);
    part->bitflags &= ~FUZZY_SPACE_BIT;
    part->has_space = false;
    return true;
}

FuzzyQuery *fuzzy_query_prepare(const char *input, size_t len)
{
    uint16_t *units = NULL;
    size_t units_len = 0;
    uint16_t *trimmed = NULL;
    size_t trimmed_len = 0;
    uint16_t *lower = NULL;
    size_t lower_len = 0;
    size_t start = 0, end = 0;
    FuzzyQuery *query = NULL;
    int part_cap = 0;

    if (!fuzzy_utf8_to_utf16(input, len, &units, &units_len))
        return NULL;

    fuzzy_remap_utf16(units, units_len);
    fuzzy_trim_utf16(units, units_len, &start, &end);

    if (start == end) {
        free(units);
        query = calloc(1, sizeof(FuzzyQuery));
        if (query == NULL)
            return NULL;
        query->empty = true;
        query->full.len = 0;
        query->full.codes = NULL;
        query->full.bitflags = 0;
        query->full.has_space = false;
        return query;
    }

    trimmed_len = end - start;
    trimmed = malloc((trimmed_len + 1) * sizeof(uint16_t));
    if (trimmed == NULL) {
        free(units);
        return NULL;
    }
    memcpy(trimmed, units + start, trimmed_len * sizeof(uint16_t));
    free(units);

    if (!fuzzy_lower_utf16(trimmed, trimmed_len, &lower, &lower_len)) {
        free(trimmed);
        return NULL;
    }
    free(trimmed);

    query = calloc(1, sizeof(FuzzyQuery));
    if (query == NULL) {
        free(lower);
        return NULL;
    }

    prepare_search_from_lower(lower, lower_len, &query->full);
    query->full.bitflags &= ~FUZZY_SPACE_BIT;
    query->empty = false;

    if (query->full.has_space) {
        int i = 0;

        while (i < query->full.len) {
            int part_start;

            while (i < query->full.len &&
                   fuzzy_is_js_space_cp(query->full.codes[i]))
                i++;
            if (i >= query->full.len)
                break;
            part_start = i;
            while (i < query->full.len &&
                   !fuzzy_is_js_space_cp(query->full.codes[i]))
                i++;

            if (!query_add_part(query, &part_cap,
                                query->full.codes + part_start,
                                i - part_start)) {
                fuzzy_query_free(query);
                return NULL;
            }
        }
    }

    return query;
}

FuzzyTarget *fuzzy_target_prepare(const char *input, size_t len)
{
    uint16_t *units = NULL;
    size_t units_len = 0;
    uint16_t *lower = NULL;
    size_t lower_len = 0;
    FuzzyTarget *target = NULL;

    if (!fuzzy_utf8_to_utf16(input, len, &units, &units_len))
        return NULL;

    fuzzy_remap_utf16(units, units_len);

    if (!fuzzy_lower_utf16(units, units_len, &lower, &lower_len)) {
        free(units);
        return NULL;
    }

    /* The remap stage is one-to-one and lowercasing after it does not change
     * length for any Unicode 17 code point.  Guard anyway. */
    if (lower_len != units_len) {
        free(units);
        free(lower);
        return NULL;
    }

    target = calloc(1, sizeof(FuzzyTarget));
    if (target == NULL) {
        free(units);
        free(lower);
        return NULL;
    }

    FuzzySearch search;
    prepare_search_from_lower(lower, lower_len, &search);
    target->codes = search.codes;
    if (!fuzzy_beginnings(units, lower, lower_len, &target->beginnings,
                          &target->view.beginnings_len, target->first_table)) {
        free(units);
        fuzzy_target_free(target);
        return NULL;
    }

    target->view.len = search.len;
    target->view.codes = target->codes;
    target->view.bitflags = search.bitflags;
    target->view.has_space = search.has_space;
    target->view.beginnings = target->beginnings;
    target->view.first_table = target->first_table;

    free(units);
    return target;
}

void fuzzy_query_free(FuzzyQuery *query)
{
    if (query == NULL)
        return;
    search_free(&query->full);
    for (int i = 0; i < query->nparts; i++)
        search_free(&query->parts[i]);
    free(query->parts);
    free(query);
}

void fuzzy_target_free(FuzzyTarget *target)
{
    if (target == NULL)
        return;
    free(target->codes);
    free(target->beginnings);
    free(target);
}

const FuzzyTargetView *fuzzy_target_view(const FuzzyTarget *target)
{
    return target != NULL ? &target->view : NULL;
}

static bool is_subsequence(const uint16_t *needle, int nlen,
                           const uint16_t *hay, int hlen)
{
    int j = 0;

    if (nlen <= 0)
        return false;
    for (int i = 0; i < hlen && j < nlen; i++) {
        if (hay[i] == needle[j])
            j++;
    }
    return j == nlen;
}

bool fuzzy_match_bool_view(const FuzzyQuery *query,
                           const FuzzyTargetView *target)
{
    if (query->empty)
        return true;
    if (target->len == 0)
        return false;

    if (!query->full.has_space) {
        if ((query->full.bitflags & target->bitflags) !=
            query->full.bitflags)
            return false;
        return is_subsequence(query->full.codes, query->full.len,
                              target->codes, target->len);
    }

    if (query->nparts == 0)
        return false;
    for (int i = 0; i < query->nparts; i++) {
        const FuzzySearch *part = &query->parts[i];

        if ((part->bitflags & target->bitflags) != part->bitflags)
            return false;
        if (!is_subsequence(part->codes, part->len,
                            target->codes, target->len))
            return false;
    }
    return true;
}

bool fuzzy_match_bool(const FuzzyQuery *query, const FuzzyTarget *target)
{
    return fuzzy_match_bool_view(query, fuzzy_target_view(target));
}

static int find_sub(const uint16_t *hay, int hlen,
                    const uint16_t *needle, int nlen, int from)
{
    if (nlen <= 0 || from < 0)
        return -1;
    if (from > hlen - nlen)
        return -1;

    for (int i = from; i <= hlen - nlen; i++) {
        if (hay[i] == needle[0] &&
            memcmp(hay + i, needle, (size_t) nlen * sizeof(uint16_t)) == 0)
            return i;
    }
    return -1;
}

static int lower_bound(const int *values, int start, int end, int value)
{
    while (start < end) {
        int middle = start + ((end - start) >> 1);
        if (values[middle] < value)
            start = middle + 1;
        else
            end = middle;
    }
    return start;
}

static int next_beginning(const int *indexes, int start, int end,
                          int index, int target_len)
{
    int next = lower_bound(indexes, start, end, index + 1);
    return next < end ? indexes[next] : target_len;
}

static bool is_beginning(const int *indexes, int start, int end, int index)
{
    int found = lower_bound(indexes, start, end, index);
    return found < end && indexes[found] == index;
}

static void build_next(const FuzzyTargetView *target, int *next)
{
    int len = target->len;
    int fill = 0;

    for (int b = 0; b < target->beginnings_len; b++) {
        int i = target->beginnings[b];
        while (fill < i)
            next[fill++] = i;
    }
    while (fill < len)
        next[fill++] = len;
}

static double score_ceiling(int search_len, int target_len)
{
    double length_penalty = (target_len - search_len) / 2.0;
    double bonus = 1 + (double) search_len * search_len;
    double score = -length_penalty - length_penalty / (bonus * bonus);

    return score + fmin(4.0, -score / 2.0);
}

static double calculate_score(const int *matches, int search_len, int target_len,
                              bool strict, int beginning_len, bool substring,
                              bool substring_start, bool substring_end)
{
    double score = 0;
    int groups = 0;

    for (int i = 1; i < search_len; i++) {
        if (matches[i] - matches[i - 1] != 1) {
            score -= matches[i];
            groups++;
        }
    }

    int unmatched_distance = matches[search_len - 1] - matches[0] - (search_len - 1);
    score -= ((double) 12 + unmatched_distance) * groups;
    if (matches[0] != 0)
        score -= (double) matches[0] * matches[0] * .2;
    if (!strict)
        score *= 1000;
    else if (beginning_len > 24)
        score *= (beginning_len - 24) * 10.0;

    double length_penalty = (target_len - search_len) / 2.0;
    score -= length_penalty;
    double substring_bonus = 1 + (double) search_len * search_len;
    if (substring)
        score /= substring_bonus;
    if (substring_start)
        score /= substring_bonus;
    score -= length_penalty;

    return substring_end ? score + fmin(4.0, -score / 2.0) : score;
}

static bool algorithm(const FuzzySearch *search, const FuzzyTargetView *target,
                      bool spaces, bool partial, bool changed, bool single_match,
                      const int *beginnings, int start, int end,
                      const int *next, double cutoff,
                      FuzzyScratch *s, AlgResult *out);

static bool algorithm2(const FuzzySearch *search, const FuzzyTargetView *target,
                       const int *beginnings, int start, int end,
                       double cutoff, FuzzyScratch *s, AlgResult *out)
{
    const uint16_t *target_codes = target->codes;
    int target_len = target->len;
    const uint16_t *search_codes = search->codes;
    int search_len = search->len;
    uint16_t first_code, second_code;
    int first = 0, second;

    if (search_len != 2 || target_len < 2)
        return false;

    first_code = search_codes[0];
    second_code = search_codes[1];

    while (target_codes[first] != first_code) {
        if (++first >= target_len)
            return false;
    }

    second = first + 1;
    while (target_codes[second] != second_code) {
        if (++second >= target_len)
            return false;
    }

    if (cutoff != -FUZZY_INF && score_ceiling(2, target_len) <= cutoff)
        return false;

    if (beginnings == NULL) {
        beginnings = target->beginnings;
        start = 0;
        end = target->beginnings_len;
    }

    int substring_i = find_sub(target_codes, target_len, search_codes, 2, first);
    bool substring = substring_i != -1;
    int low = lower_bound(beginnings, start, end, substring_i);
    bool substring_start = substring && low < end &&
                           beginnings[low] == substring_i;
    bool strict = substring_start && substring_i == first;

    if (!strict) {
        int first_beginning = start;

        while (first_beginning < end && beginnings[first_beginning] < first)
            first_beginning++;

        for (int backtracks = 0; first_beginning < end;) {
            int strict_first = beginnings[first_beginning];

            if (target_codes[strict_first] != first_code) {
                first_beginning++;
                continue;
            }

            int consecutive = strict_first + 1;
            if (consecutive < target_len &&
                target_codes[consecutive] == second_code) {
                first = strict_first;
                second = consecutive;
                strict = true;
                break;
            }

            int second_beginning = first_beginning + 1;
            while (second_beginning < end &&
                   beginnings[second_beginning] <= consecutive)
                second_beginning++;
            while (second_beginning < end &&
                   target_codes[beginnings[second_beginning]] != second_code)
                second_beginning++;

            if (second_beginning < end) {
                first = strict_first;
                second = beginnings[second_beginning];
                strict = true;
                break;
            }

            if (++backtracks > 200)
                break;
            first_beginning++;
        }
    }

    if (substring && !substring_start) {
        while (low < end && beginnings[low] <= substring_i)
            low++;
        for (; low < end; low++) {
            int index = beginnings[low];
            if (index + 1 < target_len &&
                target_codes[index] == first_code &&
                target_codes[index + 1] == second_code) {
                substring_i = index;
                substring_start = true;
                break;
            }
        }
    }

    if (substring && (!strict || substring_start)) {
        first = substring_i;
        second = substring_i + 1;
    }

    double result_score = second - first == 1 ? 0 :
        (double) first - (double) second * 2 - 11;
    if (first)
        result_score -= (double) first * first * .2;
    if (!strict)
        result_score *= 1000;
    else if (end - start > 24)
        result_score *= (end - start - 24) * 10.0;

    double length_penalty = (target_len - 2) / 2.0;
    result_score -= length_penalty;
    if (substring)
        result_score /= 5;
    if (substring_start)
        result_score /= 5;
    result_score -= length_penalty;

    bool substring_end = substring && second == first + 1 &&
        (second + 1 == target_len ||
         is_beginning(beginnings, start, end, second + 1));

    if (substring_end)
        result_score += fmin(4.0, -result_score / 2.0);

    s->out[0] = first;
    s->out[1] = second;
    out->score = result_score;
    out->indexes = s->out;
    out->len = 2;
    return true;
}

static bool algorithm_spaces(const FuzzyQuery *query, const FuzzyTargetView *target,
                             bool partial, FuzzyScratch *s, AlgResult *out)
{
    const uint16_t *target_codes = target->codes;
    int target_len = target->len;
    double score = 0;
    int previous_first = 0;
    int seen_len = 0;
    bool matched = false;
    bool changed = false;
    unsigned int generation;

    if (query->nparts == 0 || target_len == 0)
        return false;
    if (partial)
        return false;

    build_next(target, s->next);

    generation = ++s->generation;
    if (generation == 0) {
        memset(s->seen_at, 0, (size_t) s->seen_at_cap * sizeof(unsigned int));
        generation = ++s->generation;
    }

    for (int i = 0; i < query->nparts; i++) {
        AlgResult part;

        if (!algorithm(&query->parts[i], target, false, false, changed, false,
                       NULL, 0, 0, s->next, -FUZZY_INF, s, &part))
            return false;

        matched = true;

        if (i < query->nparts - 1) {
            bool consecutive = true;

            for (int j = 0; j + 1 < part.len; j++) {
                if (part.indexes[j + 1] - part.indexes[j] != 1) {
                    consecutive = false;
                    break;
                }
            }

            if (consecutive) {
                int beginning = part.indexes[part.len - 1] + 1;
                int previous = s->next[beginning - 1];

                for (int j = beginning - 1;
                     j >= 0 && s->next[j] == previous; j--)
                    s->next[j] = beginning;
                changed = true;
            }
        }

        double part_score = part.score / query->nparts;
        score += part_score;

        if (part.indexes[0] < previous_first)
            score -= (double) (previous_first - part.indexes[0]) * 2;
        previous_first = part.indexes[0];

        for (int j = 0; j < part.len; j++) {
            int index = part.indexes[j];
            if (s->seen_at[index] == generation)
                continue;
            s->seen_at[index] = generation;
            s->seen[seen_len++] = index;
        }
    }

    if (!matched)
        return false;

    if ((target->bitflags & FUZZY_SPACE_BIT) != 0) {
        AlgResult spaced;

        /* fuzzysort resets the temporarily-modified next-beginning array before
         * trying the full query, including its literal spaces. */
        build_next(target, s->next);

        if (algorithm(&query->full, target, true, false, false, true,
                      NULL, 0, 0, s->next, -FUZZY_INF, s, &spaced) &&
            spaced.score > score)
            return (*out = spaced, true);
    }

    out->score = score;
    out->indexes = s->seen;
    out->len = seen_len;
    (void) target_codes;
    return true;
}

static bool algorithm(const FuzzySearch *search, const FuzzyTargetView *target,
                      bool spaces, bool partial, bool changed, bool single_match,
                      const int *beginnings, int start, int end,
                      const int *next, double cutoff,
                      FuzzyScratch *s, AlgResult *out)
{
    const uint16_t *search_codes = search->codes;
    const uint16_t *target_codes = target->codes;
    int search_len = search->len;
    int target_len = target->len;
    int search_i = 0;
    int target_i = 0;
    uint16_t search_code;

    (void) spaces;
    (void) partial;

    if (search_len <= 0 || target_len <= 0)
        return false;

    if (beginnings == NULL && next == NULL) {
        build_next(target, s->next);
        next = s->next;
    }

    search_code = search_codes[0];
    for (;;) {
        if (search_code == target_codes[target_i]) {
            s->simple[search_i] = target_i;
            if (++search_i == search_len)
                break;
            search_code = search_codes[search_i];
        }
        if (++target_i >= target_len)
            return false;
    }

    if (cutoff != -FUZZY_INF && search_len > 1 &&
        score_ceiling(search_len, target_len) <= cutoff)
        return false;

    if (search_len == 1 && !changed && single_match) {
        int match_i = s->simple[0];
        bool strict = false;

        for (int b = 0; b < target->beginnings_len; b++) {
            int idx = target->beginnings[b];
            if (target_codes[idx] == search_code) {
                match_i = idx;
                strict = true;
                break;
            }
        }

        double result_score = match_i == 0 ? 0 :
            -(double) match_i * match_i * .2;
        if (!strict)
            result_score *= 1000;
        else if (target->beginnings_len > 24)
            result_score *= (target->beginnings_len - 24) * 10.0;

        s->out[0] = match_i;
        out->score = result_score - (target_len - 1);
        out->indexes = s->out;
        out->len = 1;
        return true;
    }

    search_i = 0;
    bool strict = false;
    int strict_len = 0;
    int beginning_len;

    if (beginnings == NULL) {
        beginning_len = changed ? 0 : target->beginnings_len;
        if (!beginning_len) {
            beginning_len = 1;
            for (int i = next[0]; i < target_len; i = next[i])
                beginning_len++;
        }
    } else {
        beginning_len = end - start;
    }

    int substring_i = search_len <= 1 ? -1 :
        find_sub(target_codes, target_len, search_codes, search_len,
                 s->simple[0]);
    bool is_substring = substring_i != -1;
    bool substring_start = is_substring &&
        (substring_i == 0 ||
         (beginnings ? is_beginning(beginnings, start, end, substring_i)
                     : next[substring_i - 1] == substring_i));

    if (substring_start && substring_i == s->simple[0]) {
        strict = true;
    } else {
        target_i = s->simple[0] == 0 ? 0 :
            (beginnings ? next_beginning(beginnings, start, end,
                                         s->simple[0] - 1, target_len)
                        : next[s->simple[0] - 1]);

        int backtracks = 0;
        if (target_i != target_len) {
            for (;;) {
                if (target_i >= target_len) {
                    if (search_i <= 0 || ++backtracks > 200)
                        break;
                    search_i--;
                    int previous = s->strict[--strict_len];
                    target_i = beginnings
                        ? next_beginning(beginnings, start, end,
                                         previous, target_len)
                        : next[previous];
                } else if (search_codes[search_i] == target_codes[target_i]) {
                    s->strict[strict_len++] = target_i;
                    if (++search_i == search_len) {
                        strict = true;
                        break;
                    }
                    target_i++;
                } else {
                    target_i = beginnings
                        ? next_beginning(beginnings, start, end,
                                         target_i, target_len)
                        : next[target_i];
                }
            }
        }
    }

    if (is_substring && !substring_start) {
        if (beginnings) {
            for (int b = start; b < end; b++) {
                int i = beginnings[b];
                if (i <= substring_i)
                    continue;
                int j = 0;
                for (; j < search_len; j++) {
                    if (i + j >= target_len ||
                        search_codes[j] != target_codes[i + j])
                        break;
                }
                if (j == search_len) {
                    substring_i = i;
                    substring_start = true;
                    break;
                }
            }
        } else {
            for (int i = 0; i < target_len; i = next[i]) {
                if (i <= substring_i)
                    continue;
                int j = 0;
                for (; j < search_len; j++) {
                    if (i + j >= target_len ||
                        search_codes[j] != target_codes[i + j])
                        break;
                }
                if (j == search_len) {
                    substring_i = i;
                    substring_start = true;
                    break;
                }
            }
        }
    }

    const int *matches;
    if (!strict) {
        if (is_substring) {
            for (int i = 0; i < search_len; i++)
                s->simple[i] = substring_i + i;
        }
        matches = s->simple;
    } else if (substring_start) {
        for (int i = 0; i < search_len; i++)
            s->simple[i] = substring_i + i;
        matches = s->simple;
    } else {
        matches = s->strict;
    }

    int match_end = matches[search_len - 1] + 1;
    bool substring_end = is_substring &&
        match_end - matches[0] == search_len &&
        (match_end == target_len ||
         (beginnings ? is_beginning(beginnings, start, end, match_end)
                     : next[match_end - 1] == match_end));

    out->score = calculate_score(matches, search_len, target_len, strict,
                                 beginning_len, is_substring, substring_start,
                                 substring_end);
    for (int i = 0; i < search_len; i++)
        s->out[i] = matches[i];
    out->indexes = s->out;
    out->len = search_len;
    return true;
}

static double normalize_score(double value)
{
    if (value == -FUZZY_INF)
        return 0;
    if (value > 1)
        return value;
    return pow(FUZZY_E, (pow(-value + 1, .04307) - 1) * -2);
}

static void sort_indexes(int *indexes, int len)
{
    for (int i = 1; i < len; i++) {
        int value = indexes[i];
        int j = i - 1;
        while (j >= 0 && indexes[j] > value) {
            indexes[j + 1] = indexes[j];
            j--;
        }
        indexes[j + 1] = value;
    }
}

bool fuzzy_score_view(const FuzzyQuery *query, const FuzzyTargetView *target,
                      FuzzyScratch *scratch, FuzzyResult *result)
{
    AlgResult alg;
    bool matched;

    result->matched = false;
    result->raw_score = -FUZZY_INF;
    result->score = 0;
    result->indexes = NULL;
    result->index_count = 0;

    if (scratch == NULL)
        return false;
    scratch->oom = false;

    if (query->empty) {
        result->matched = true;
        result->score = 0;
        return true;
    }

    if (!fuzzy_scratch_reserve(scratch, query->full.len, query->nparts,
                               target->len)) {
        scratch->oom = true;
        return false;
    }

    if (query->full.len == 2 && !query->full.has_space)
        matched = algorithm2(&query->full, target, target->beginnings, 0,
                             target->beginnings_len, -FUZZY_INF, scratch, &alg);
    else if (query->full.has_space)
        matched = algorithm_spaces(query, target, false, scratch, &alg);
    else
        matched = algorithm(&query->full, target, false, false, false, true,
                            target->beginnings, 0, target->beginnings_len,
                            NULL, -FUZZY_INF, scratch, &alg);

    if (!matched)
        return false;

    result->matched = true;
    result->raw_score = alg.score;
    result->score = normalize_score(alg.score);
    result->index_count = alg.len;
    if (alg.len > 0) {
        for (int i = 0; i < alg.len; i++)
            scratch->result[i] = alg.indexes[i];
        sort_indexes(scratch->result, alg.len);
        result->indexes = scratch->result;
    }
    return true;
}

bool fuzzy_score(const FuzzyQuery *query, const FuzzyTarget *target,
                 FuzzyScratch *scratch, FuzzyResult *result)
{
    return fuzzy_score_view(query, fuzzy_target_view(target), scratch, result);
}

char *fuzzy_debug_query_normalize(const char *input, size_t len, size_t *out_len)
{
    FuzzyQuery *query = fuzzy_query_prepare(input, len);

    if (query == NULL)
        return NULL;
    if (query->empty) {
        char *empty = malloc(1);
        if (empty != NULL)
            empty[0] = '\0';
        if (out_len != NULL)
            *out_len = 0;
        fuzzy_query_free(query);
        return empty;
    }
    char *result = fuzzy_utf16_to_utf8(query->full.codes,
                                      (size_t) query->full.len, out_len);
    fuzzy_query_free(query);
    return result;
}

char *fuzzy_debug_target_normalize(const char *input, size_t len, size_t *out_len)
{
    FuzzyTarget *target = fuzzy_target_prepare(input, len);
    char *result;

    if (target == NULL)
        return NULL;
    result = fuzzy_utf16_to_utf8(target->codes,
                                 (size_t) target->view.len, out_len);
    fuzzy_target_free(target);
    return result;
}

bool fuzzy_debug_target_beginnings(const char *input, size_t len,
                                   int **out, int *out_count)
{
    FuzzyTarget *target = fuzzy_target_prepare(input, len);
    int *copy;

    if (target == NULL)
        return false;

    copy = malloc((size_t) (target->view.beginnings_len + 1) * sizeof(int));
    if (copy == NULL) {
        fuzzy_target_free(target);
        return false;
    }
    memcpy(copy, target->beginnings,
           (size_t) target->view.beginnings_len * sizeof(int));
    *out = copy;
    *out_count = target->view.beginnings_len;
    fuzzy_target_free(target);
    return true;
}
