#ifndef FUZZY_TYPE_H
#define FUZZY_TYPE_H

#include "postgres.h"
#include "varatt.h"

#include "fuzzy_core.h"

#define FUZZY_TARGET_MAGIC 0x465A5431u /* "FZT1" */
#define FUZZY_TARGET_FORMAT_VERSION_V1 1u
#define FUZZY_TARGET_FORMAT_VERSION 2u
#define FUZZY_TARGET_FLAG_HAS_SPACE 0x1u
#define FUZZY_TARGET_FLAG_ASCII 0x2u

/*
 * Version 1 payload (kept readable for 0.2.0 prepared values).  New values
 * use the compact version 2 layout below.
 */
typedef struct FuzzyTargetPayload
{
    uint32      magic;
    uint32      format_version;
    uint32      bitflags;
    uint32      flags;
    int32       target_len;       /* UTF-16 code units */
    int32       beginnings_len;
    int32       first_table[26];

    /* followed by int32 beginnings[beginnings_len], then uint16 codes[target_len] */
} FuzzyTargetPayload;

/*
 * Version 2 payload.  ASCII targets store one byte per code unit; other
 * targets store UTF-16.  Beginnings remain int32 for a simple non-owning view.
 */
typedef struct FuzzyTargetPayloadV2
{
    uint32      magic;
    uint16      format_version;
    uint16      flags;
    uint32      bitflags;
    uint32      target_len;
    uint32      beginnings_len;

    /* followed by int32 beginnings[beginnings_len], then codes[] */
} FuzzyTargetPayloadV2;

/* Validate a payload and point a non-owning view into it.  Raises ERROR on
 * corrupt data. */
extern void fuzzy_target_payload_view(const FuzzyTargetPayload *payload,
                                      Size payload_len,
                                      FuzzyTargetView *view);

/* Build a palloc'd payload from a core target view. */
extern void *fuzzy_target_payload_create(const FuzzyTargetView *view,
                                         Size *payload_len);

#endif
