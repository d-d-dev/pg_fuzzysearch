#ifndef FUZZY_TYPE_H
#define FUZZY_TYPE_H

#include "postgres.h"
#include "varatt.h"

#include "fuzzy_core.h"

#define FUZZY_TARGET_MAGIC 0x465A5431u /* "FZT1" */
#define FUZZY_TARGET_FORMAT_VERSION 1u
#define FUZZY_TARGET_FLAG_HAS_SPACE 0x1u

/*
 * Payload stored in the fuzzy_target varlena after the 4-byte varlena header.
 * All fields are native-endian; pg_dump/dump/restore is the portability path.
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

/* Validate a payload and point a non-owning view into it.  Raises ERROR on
 * corrupt data. */
extern void fuzzy_target_payload_view(const FuzzyTargetPayload *payload,
                                      Size payload_len,
                                      FuzzyTargetView *view);

/* Build a palloc'd payload from a core target view. */
extern FuzzyTargetPayload *fuzzy_target_payload_create(const FuzzyTargetView *view,
                                                       Size *payload_len);

#endif
