#define _POSIX_C_SOURCE 200809L

#include "fuzzy_core.h"

#include <ctype.h>
#include <math.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>

static int hex_value(int c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static unsigned char *hex_decode(const char *hex, size_t len, size_t *out_len)
{
    unsigned char *out;

    if (len % 2 != 0)
        return NULL;
    out = malloc(len / 2 + 1);
    if (out == NULL)
        return NULL;
    for (size_t i = 0; i < len; i += 2) {
        int hi = hex_value((unsigned char) hex[i]);
        int lo = hex_value((unsigned char) hex[i + 1]);
        if (hi < 0 || lo < 0) {
            free(out);
            return NULL;
        }
        out[i / 2] = (unsigned char) ((hi << 4) | lo);
    }
    *out_len = len / 2;
    return out;
}

static void print_hex(const char *data, size_t len)
{
    static const char digits[] = "0123456789abcdef";
    for (size_t i = 0; i < len; i++) {
        unsigned char c = (unsigned char) data[i];
        putchar(digits[c >> 4]);
        putchar(digits[c & 0xf]);
    }
}

static char *trim_newline(char *line)
{
    size_t len = strlen(line);
    while (len > 0 && (line[len - 1] == '\n' || line[len - 1] == '\r'))
        line[--len] = '\0';
    return line;
}

static int split_tab(char *line, char **left, char **right)
{
    char *tab = strchr(line, '\t');
    if (tab == NULL)
        return 0;
    *tab = '\0';
    *left = line;
    *right = tab + 1;
    return 1;
}

static int run_score(void)
{
    char *line = NULL;
    size_t cap = 0;
    ssize_t nread;
    FuzzyScratch *scratch = fuzzy_scratch_new();

    if (scratch == NULL)
        return 1;

    while ((nread = getline(&line, &cap, stdin)) >= 0) {
        char *qhex, *thex;
        size_t qlen, tlen;
        unsigned char *qbytes = NULL, *tbytes = NULL;
        FuzzyQuery *query = NULL;
        FuzzyTarget *target = NULL;
        FuzzyResult result;
        bool bool_match;

        (void) nread;
        trim_newline(line);
        if (!split_tab(line, &qhex, &thex))
            continue;

        qbytes = hex_decode(qhex, strlen(qhex), &qlen);
        tbytes = hex_decode(thex, strlen(thex), &tlen);
        if (qbytes == NULL || tbytes == NULL) {
            fprintf(stderr, "invalid hex input\n");
            free(qbytes);
            free(tbytes);
            fuzzy_scratch_free(scratch);
            free(line);
            return 1;
        }

        query = fuzzy_query_prepare((const char *) qbytes, qlen);
        target = fuzzy_target_prepare((const char *) tbytes, tlen);
        if (query == NULL || target == NULL) {
            fprintf(stderr, "invalid UTF-8 input\n");
            free(qbytes);
            free(tbytes);
            fuzzy_query_free(query);
            fuzzy_target_free(target);
            fuzzy_scratch_free(scratch);
            free(line);
            return 1;
        }

        bool_match = fuzzy_match_bool(query, target);
        fuzzy_score(query, target, scratch, &result);

        printf("%d\t%d\t", bool_match ? 1 : 0, result.matched ? 1 : 0);
        if (result.matched) {
            if (result.raw_score == -INFINITY)
                printf("-Infinity\t");
            else
                printf("%.17g\t", result.raw_score);
            printf("%.17g\t", result.score);
            for (int i = 0; i < result.index_count; i++) {
                if (i > 0)
                    putchar(',');
                printf("%d", result.indexes[i]);
            }
        } else {
            printf("\t\t");
        }
        putchar('\n');

        free(qbytes);
        free(tbytes);
        fuzzy_query_free(query);
        fuzzy_target_free(target);
    }

    fuzzy_scratch_free(scratch);
    free(line);
    return 0;
}

static int run_normalize(bool query_mode)
{
    char *line = NULL;
    size_t cap = 0;
    ssize_t nread;

    while ((nread = getline(&line, &cap, stdin)) >= 0) {
        size_t len, out_len;
        unsigned char *bytes;
        char *normalized;

        (void) nread;
        trim_newline(line);
        bytes = hex_decode(line, strlen(line), &len);
        if (bytes == NULL) {
            fprintf(stderr, "invalid hex input\n");
            free(line);
            return 1;
        }

        normalized = query_mode
            ? fuzzy_debug_query_normalize((const char *) bytes, len, &out_len)
            : fuzzy_debug_target_normalize((const char *) bytes, len, &out_len);
        if (normalized == NULL) {
            fprintf(stderr, "invalid UTF-8 input\n");
            free(bytes);
            free(line);
            return 1;
        }

        print_hex(normalized, out_len);
        putchar('\n');

        free(normalized);
        free(bytes);
    }

    free(line);
    return 0;
}

static int run_beginnings(void)
{
    char *line = NULL;
    size_t cap = 0;
    ssize_t nread;

    while ((nread = getline(&line, &cap, stdin)) >= 0) {
        size_t len;
        unsigned char *bytes;
        int *beginnings = NULL;
        int count = 0;

        (void) nread;
        trim_newline(line);
        bytes = hex_decode(line, strlen(line), &len);
        if (bytes == NULL) {
            fprintf(stderr, "invalid hex input\n");
            free(line);
            return 1;
        }

        if (!fuzzy_debug_target_beginnings((const char *) bytes, len,
                                           &beginnings, &count)) {
            fprintf(stderr, "invalid UTF-8 input\n");
            free(bytes);
            free(line);
            return 1;
        }

        for (int i = 0; i < count; i++) {
            if (i > 0)
                putchar(',');
            printf("%d", beginnings[i]);
        }
        putchar('\n');

        free(beginnings);
        free(bytes);
    }

    free(line);
    return 0;
}

int main(int argc, char **argv)
{
    if (argc != 2) {
        fprintf(stderr,
                "usage: %s score|normalize-query|normalize-target|beginnings\n",
                argv[0]);
        return 2;
    }

    if (strcmp(argv[1], "score") == 0)
        return run_score();
    if (strcmp(argv[1], "normalize-query") == 0)
        return run_normalize(true);
    if (strcmp(argv[1], "normalize-target") == 0)
        return run_normalize(false);
    if (strcmp(argv[1], "beginnings") == 0)
        return run_beginnings();

    fprintf(stderr, "unknown mode: %s\n", argv[1]);
    return 2;
}
