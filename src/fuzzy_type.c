#include "postgres.h"

#include <string.h>

#include "fmgr.h"
#include "libpq/pqformat.h"
#include "mb/pg_wchar.h"
#include "utils/memutils.h"
#include "varatt.h"

#include "fuzzy_core.h"
#include "fuzzy_type.h"

#define FUZZY_TARGET_TEXT_PREFIX "FX1:"

static void
fuzzy_corrupt(const char *detail)
{
    ereport(ERROR,
            (errcode(ERRCODE_DATA_CORRUPTED),
             errmsg("invalid fuzzy_target value"),
             errdetail("%s", detail)));
}

void
fuzzy_target_payload_view(const FuzzyTargetPayload *payload, Size payload_len,
                          FuzzyTargetView *view)
{
    if (payload_len < sizeof(FuzzyTargetPayload))
        fuzzy_corrupt("payload is too short");

    if (payload->magic != FUZZY_TARGET_MAGIC)
        fuzzy_corrupt("bad magic");
    if (payload->format_version != FUZZY_TARGET_FORMAT_VERSION)
        fuzzy_corrupt("unsupported format version");
    if ((payload->flags & ~FUZZY_TARGET_FLAG_HAS_SPACE) != 0)
        fuzzy_corrupt("unknown flags");
    if (payload->target_len < 0 || payload->beginnings_len < 0)
        fuzzy_corrupt("negative length");

    Size base = sizeof(FuzzyTargetPayload);
    Size blen = (Size) payload->beginnings_len;
    Size tlen = (Size) payload->target_len;

    if (blen > (MaxAllocSize - base) / sizeof(int32))
        fuzzy_corrupt("beginnings length overflows");
    Size after_beginnings = base + blen * sizeof(int32);
    if (tlen > (MaxAllocSize - after_beginnings) / sizeof(uint16))
        fuzzy_corrupt("target length overflows");
    Size expected = after_beginnings + tlen * sizeof(uint16);
    if (expected != payload_len)
        fuzzy_corrupt("payload length does not match header");

    const int32 *beginnings =
        (const int32 *) ((const char *) payload + base);
    int32 previous = -1;
    for (Size i = 0; i < blen; i++)
    {
        int32 value = beginnings[i];
        if (value < 0 || value >= payload->target_len || value < previous)
            fuzzy_corrupt("invalid beginning offset");
        previous = value;
    }

    for (int i = 0; i < 26; i++)
    {
        int32 value = payload->first_table[i];
        if (value < 0 || value > payload->target_len)
            fuzzy_corrupt("invalid first-letter table");
    }

    view->len = payload->target_len;
    view->codes = (const uint16_t *) ((const char *) payload + after_beginnings);
    view->bitflags = payload->bitflags;
    view->has_space = (payload->flags & FUZZY_TARGET_FLAG_HAS_SPACE) != 0;
    view->beginnings_len = payload->beginnings_len;
    view->beginnings = (const int *) beginnings;
    view->first_table = payload->first_table;
}

FuzzyTargetPayload *
fuzzy_target_payload_create(const FuzzyTargetView *view, Size *payload_len)
{
    if (view->len < 0 || view->beginnings_len < 0)
        ereport(ERROR,
                (errcode(ERRCODE_INTERNAL_ERROR),
                 errmsg("pg_fuzzysearch: invalid prepared target")));

    Size base = sizeof(FuzzyTargetPayload);
    Size blen = (Size) view->beginnings_len;
    Size tlen = (Size) view->len;

    if (blen > (MaxAllocSize - base) / sizeof(int32))
        ereport(ERROR,
                (errcode(ERRCODE_PROGRAM_LIMIT_EXCEEDED),
                 errmsg("pg_fuzzysearch: prepared target is too large")));
    Size after_beginnings = base + blen * sizeof(int32);
    if (tlen > (MaxAllocSize - after_beginnings) / sizeof(uint16))
        ereport(ERROR,
                (errcode(ERRCODE_PROGRAM_LIMIT_EXCEEDED),
                 errmsg("pg_fuzzysearch: prepared target is too large")));
    Size total = after_beginnings + tlen * sizeof(uint16);

    FuzzyTargetPayload *payload = palloc0(total);
    payload->magic = FUZZY_TARGET_MAGIC;
    payload->format_version = FUZZY_TARGET_FORMAT_VERSION;
    payload->bitflags = view->bitflags;
    payload->flags = view->has_space ? FUZZY_TARGET_FLAG_HAS_SPACE : 0;
    payload->target_len = view->len;
    payload->beginnings_len = view->beginnings_len;

    if (view->first_table != NULL)
        memcpy(payload->first_table, view->first_table,
               26 * sizeof(int32));

    int32 *beginnings =
        (int32 *) ((char *) payload + base);
    for (Size i = 0; i < blen; i++)
        beginnings[i] = view->beginnings[i];

    uint16_t *codes =
        (uint16_t *) ((char *) beginnings + blen * sizeof(int32));
    if (tlen > 0)
        memcpy(codes, view->codes, tlen * sizeof(uint16_t));

    *payload_len = total;
    return payload;
}

static int
hex_digit(char c)
{
    if (c >= '0' && c <= '9')
        return c - '0';
    if (c >= 'a' && c <= 'f')
        return c - 'a' + 10;
    if (c >= 'A' && c <= 'F')
        return c - 'A' + 10;
    return -1;
}

static void
encode_hex(char *dst, const unsigned char *src, Size len)
{
    static const char digits[] = "0123456789abcdef";

    for (Size i = 0; i < len; i++)
    {
        dst[i * 2] = digits[src[i] >> 4];
        dst[i * 2 + 1] = digits[src[i] & 0x0f];
    }
}

static bool
decode_hex(unsigned char *dst, const char *src, Size len)
{
    for (Size i = 0; i < len / 2; i++)
    {
        int hi = hex_digit(src[i * 2]);
        int lo = hex_digit(src[i * 2 + 1]);

        if (hi < 0 || lo < 0)
            return false;
        dst[i] = (unsigned char) ((hi << 4) | lo);
    }
    return true;
}

static void
require_utf8(void)
{
    if (GetDatabaseEncoding() != PG_UTF8)
        ereport(ERROR,
                (errcode(ERRCODE_FEATURE_NOT_SUPPORTED),
                 errmsg("pg_fuzzysearch requires a UTF-8 database"),
                 errdetail("The current database encoding is %s.",
                           GetDatabaseEncodingName())));
}

PG_FUNCTION_INFO_V1(fuzzy_target_in);
PG_FUNCTION_INFO_V1(fuzzy_target_out);
PG_FUNCTION_INFO_V1(fuzzy_target_recv);
PG_FUNCTION_INFO_V1(fuzzy_target_send);
PG_FUNCTION_INFO_V1(pg_fuzzy_prepare);

Datum
fuzzy_target_in(PG_FUNCTION_ARGS)
{
    char       *input = PG_GETARG_CSTRING(0);
    Size        input_len = strlen(input);
    Size        hex_len;
    Size        payload_len;
    struct varlena *result;
    FuzzyTargetView view;

    if (input_len < sizeof(FUZZY_TARGET_TEXT_PREFIX) - 1 ||
        memcmp(input, FUZZY_TARGET_TEXT_PREFIX,
               sizeof(FUZZY_TARGET_TEXT_PREFIX) - 1) != 0)
        ereport(ERROR,
                (errcode(ERRCODE_INVALID_TEXT_REPRESENTATION),
                 errmsg("invalid input syntax for type fuzzy_target"),
                 errdetail("Expected the FX1: prefix.")));

    hex_len = input_len - (sizeof(FUZZY_TARGET_TEXT_PREFIX) - 1);
    if ((hex_len & 1) != 0)
        ereport(ERROR,
                (errcode(ERRCODE_INVALID_TEXT_REPRESENTATION),
                 errmsg("invalid input syntax for type fuzzy_target"),
                 errdetail("Hex payload has odd length.")));

    payload_len = hex_len / 2;
    if (payload_len > MaxAllocSize - VARHDRSZ)
        ereport(ERROR,
                (errcode(ERRCODE_PROGRAM_LIMIT_EXCEEDED),
                 errmsg("fuzzy_target value is too large")));

    result = palloc(VARHDRSZ + payload_len);
    SET_VARSIZE(result, VARHDRSZ + payload_len);
    if (!decode_hex((unsigned char *) VARDATA(result),
                    input + (sizeof(FUZZY_TARGET_TEXT_PREFIX) - 1),
                    hex_len))
        ereport(ERROR,
                (errcode(ERRCODE_INVALID_TEXT_REPRESENTATION),
                 errmsg("invalid input syntax for type fuzzy_target"),
                 errdetail("Payload is not valid hexadecimal.")));

    fuzzy_target_payload_view((const FuzzyTargetPayload *) VARDATA(result),
                              payload_len, &view);
    PG_RETURN_POINTER(result);
}

Datum
fuzzy_target_out(PG_FUNCTION_ARGS)
{
    struct varlena *value = PG_GETARG_VARLENA_P(0);
    Size        payload_len = VARSIZE(value) - VARHDRSZ;
    FuzzyTargetView view;
    char       *output;
    Size        output_len;

    fuzzy_target_payload_view((const FuzzyTargetPayload *) VARDATA(value),
                              payload_len, &view);

    if (payload_len > (MaxAllocSize - 5) / 2)
        ereport(ERROR,
                (errcode(ERRCODE_PROGRAM_LIMIT_EXCEEDED),
                 errmsg("fuzzy_target value is too large to display")));

    output_len = (sizeof(FUZZY_TARGET_TEXT_PREFIX) - 1) + payload_len * 2;
    output = palloc(output_len + 1);
    memcpy(output, FUZZY_TARGET_TEXT_PREFIX,
           sizeof(FUZZY_TARGET_TEXT_PREFIX) - 1);
    encode_hex(output + (sizeof(FUZZY_TARGET_TEXT_PREFIX) - 1),
               (const unsigned char *) VARDATA(value), payload_len);
    output[output_len] = '\0';

    PG_RETURN_CSTRING(output);
}

Datum
fuzzy_target_send(PG_FUNCTION_ARGS)
{
    struct varlena *value = PG_GETARG_VARLENA_P(0);
    Size        payload_len = VARSIZE(value) - VARHDRSZ;
    FuzzyTargetView view;
    StringInfoData buf;

    fuzzy_target_payload_view((const FuzzyTargetPayload *) VARDATA(value),
                              payload_len, &view);

    pq_begintypsend(&buf);
    pq_sendbytes(&buf, VARDATA(value), (int) payload_len);
    PG_RETURN_BYTEA_P(pq_endtypsend(&buf));
}

Datum
fuzzy_target_recv(PG_FUNCTION_ARGS)
{
    StringInfo  buf = (StringInfo) PG_GETARG_POINTER(0);
    int         nbytes = buf->len - buf->cursor;
    const char *data;
    struct varlena *result;
    FuzzyTargetView view;

    if (nbytes < 0)
        ereport(ERROR,
                (errcode(ERRCODE_INVALID_BINARY_REPRESENTATION),
                 errmsg("invalid binary fuzzy_target value")));
    if ((Size) nbytes > MaxAllocSize - VARHDRSZ)
        ereport(ERROR,
                (errcode(ERRCODE_PROGRAM_LIMIT_EXCEEDED),
                 errmsg("fuzzy_target value is too large")));

    data = pq_getmsgbytes(buf, nbytes);
    result = palloc(VARHDRSZ + (Size) nbytes);
    SET_VARSIZE(result, VARHDRSZ + (Size) nbytes);
    if (nbytes > 0)
        memcpy(VARDATA(result), data, (Size) nbytes);

    fuzzy_target_payload_view((const FuzzyTargetPayload *) VARDATA(result),
                              (Size) nbytes, &view);
    PG_RETURN_POINTER(result);
}

Datum
pg_fuzzy_prepare(PG_FUNCTION_ARGS)
{
    text       *value = PG_GETARG_TEXT_PP(0);
    FuzzyTarget *target;
    const FuzzyTargetView *view;
    FuzzyTargetPayload *payload;
    Size        payload_len;
    struct varlena *result;

    require_utf8();
    target = fuzzy_target_prepare(VARDATA_ANY(value),
                                  (size_t) VARSIZE_ANY_EXHDR(value));
    if (target == NULL)
        ereport(ERROR,
                (errcode(ERRCODE_OUT_OF_MEMORY),
                 errmsg("pg_fuzzysearch: could not prepare target")));

    view = fuzzy_target_view(target);
    payload = fuzzy_target_payload_create(view, &payload_len);

    result = palloc(VARHDRSZ + payload_len);
    SET_VARSIZE(result, VARHDRSZ + payload_len);
    memcpy(VARDATA(result), payload, payload_len);

    pfree(payload);
    fuzzy_target_free(target);
    PG_RETURN_POINTER(result);
}
