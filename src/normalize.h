#ifndef FUZZY_NORMALIZE_H
#define FUZZY_NORMALIZE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define FUZZY_SPACE_BIT (1u << 27)

/* UTF-8 <-> UTF-16 (UTF-16 is used because fuzzysort/JavaScript operate on
 * UTF-16 code units).  Both functions return false on invalid input / OOM. */
bool fuzzy_utf8_to_utf16(const char *s, size_t len, uint16_t **out, size_t *out_len);
char *fuzzy_utf16_to_utf8(const uint16_t *s, size_t len, size_t *out_len);

/* In-place fuzzysort character remapping (quotes, dashes, compatibility
 * characters, etc.).  Operates one UTF-16 code unit at a time. */
void fuzzy_remap_utf16(uint16_t *units, size_t len);

/* JS String.prototype.trim(), using ECMAScript WhiteSpace/LineTerminator. */
bool fuzzy_trim_utf16(const uint16_t *in, size_t len, size_t *start, size_t *end);

/* JS String.prototype.toLowerCase(), root locale, including Final_Sigma. */
bool fuzzy_lower_utf16(const uint16_t *in, size_t len, uint16_t **out, size_t *out_len);

/* fuzzysort lowerInfoRemapped bitflags. */
void fuzzy_bitflags(const uint16_t *codes, size_t len, uint32_t *flags, bool *has_space);

/* fuzzysort scanBeginnings/indexBeginnings.  remapped is the remapped,
 * non-lowercased UTF-16 string; lower is the lowercased string. */
bool fuzzy_beginnings(const uint16_t *remapped, const uint16_t *lower, size_t len,
                      int **out_beginnings, int *out_count, int first_table[26]);

#endif
