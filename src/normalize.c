#include "normalize.h"
#include "tables.h"

#include <stdlib.h>
#include <string.h>

static bool decode_utf8(const char *s, size_t len, size_t *i, uint32_t *cp)
{
    const unsigned char *p = (const unsigned char *) s;
    size_t pos = *i;

    if (pos >= len)
        return false;

    unsigned char b0 = p[pos++];
    uint32_t value;
    int extra;

    if (b0 < 0x80) {
        value = b0;
        extra = 0;
    } else if ((b0 & 0xe0) == 0xc0) {
        value = b0 & 0x1f;
        extra = 1;
    } else if ((b0 & 0xf0) == 0xe0) {
        value = b0 & 0x0f;
        extra = 2;
    } else if ((b0 & 0xf8) == 0xf0) {
        value = b0 & 0x07;
        extra = 3;
    } else {
        return false;
    }

    if (pos + (size_t) extra > len)
        return false;

    for (int n = 0; n < extra; n++) {
        unsigned char b = p[pos++];
        if ((b & 0xc0) != 0x80)
            return false;
        value = (value << 6) | (b & 0x3f);
    }

    if (extra == 1 && value < 0x80)
        return false;
    if (extra == 2 && value < 0x800)
        return false;
    if (extra == 3 && value < 0x10000)
        return false;
    if (value > 0x10ffff)
        return false;
    if (value >= 0xd800 && value <= 0xdfff)
        return false;

    *cp = value;
    *i = pos;
    return true;
}

bool fuzzy_utf8_to_utf16(const char *s, size_t len, uint16_t **out, size_t *out_len)
{
    uint16_t *result;
    size_t i = 0;
    size_t n = 0;

    /* Each input byte can produce at most one UTF-16 code unit, and a
     * supplementary code point (4 bytes) produces two units. */
    result = malloc((len + 1) * sizeof(uint16_t));
    if (result == NULL)
        return false;

    while (i < len) {
        uint32_t cp;

        if (!decode_utf8(s, len, &i, &cp)) {
            free(result);
            return false;
        }

        if (cp <= 0xffff) {
            result[n++] = (uint16_t) cp;
        } else {
            cp -= 0x10000;
            result[n++] = (uint16_t) (0xd800 + (cp >> 10));
            result[n++] = (uint16_t) (0xdc00 + (cp & 0x3ff));
        }
    }

    *out = result;
    *out_len = n;
    return true;
}

char *fuzzy_utf16_to_utf8(const uint16_t *s, size_t len, size_t *out_len)
{
    char *result = malloc(len * 3 + 1);
    size_t n = 0;

    if (result == NULL)
        return NULL;

    for (size_t i = 0; i < len; i++) {
        uint32_t cp = s[i];

        if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < len &&
            s[i + 1] >= 0xdc00 && s[i + 1] <= 0xdfff) {
            cp = 0x10000 + ((cp - 0xd800) << 10) + (s[i + 1] - 0xdc00);
            i++;
        } else if (cp >= 0xd800 && cp <= 0xdfff) {
            cp = 0xfffd;
        }

        if (cp < 0x80) {
            result[n++] = (char) cp;
        } else if (cp < 0x800) {
            result[n++] = (char) (0xc0 | (cp >> 6));
            result[n++] = (char) (0x80 | (cp & 0x3f));
        } else if (cp < 0x10000) {
            result[n++] = (char) (0xe0 | (cp >> 12));
            result[n++] = (char) (0x80 | ((cp >> 6) & 0x3f));
            result[n++] = (char) (0x80 | (cp & 0x3f));
        } else {
            result[n++] = (char) (0xf0 | (cp >> 18));
            result[n++] = (char) (0x80 | ((cp >> 12) & 0x3f));
            result[n++] = (char) (0x80 | ((cp >> 6) & 0x3f));
            result[n++] = (char) (0x80 | (cp & 0x3f));
        }
    }

    result[n] = '\0';
    *out_len = n;
    return result;
}

static uint16_t remap_unit(uint16_t unit)
{
    if (unit < 0x80) {
        switch (unit) {
            case '"':
                return '\'';
            case '\\':
                return '/';
            case '`':
                return '\'';
            default:
                return unit;
        }
    }
    return fuzzy_remap_bmp_lookup(unit);
}

void fuzzy_remap_utf16(uint16_t *units, size_t len)
{
    for (size_t i = 0; i < len; i++)
        units[i] = remap_unit(units[i]);
}

bool fuzzy_trim_utf16(const uint16_t *in, size_t len, size_t *start, size_t *end)
{
    size_t lo = 0;
    size_t hi = len;

    while (lo < hi && fuzzy_is_js_space_cp(in[lo]))
        lo++;
    while (hi > lo && fuzzy_is_js_space_cp(in[hi - 1]))
        hi--;

    *start = lo;
    *end = hi;
    return lo < hi;
}

static bool decode_utf16_cp(const uint16_t *s, size_t len, size_t i,
                            uint32_t *cp, size_t *width)
{
    if (i >= len)
        return false;

    uint16_t u = s[i];
    if (u >= 0xd800 && u <= 0xdbff && i + 1 < len &&
        s[i + 1] >= 0xdc00 && s[i + 1] <= 0xdfff) {
        *cp = 0x10000 + ((uint32_t) (u - 0xd800) << 10) + (s[i + 1] - 0xdc00);
        *width = 2;
        return true;
    }

    *cp = u;
    *width = 1;
    return true;
}

static bool next_cp(const uint16_t *s, size_t len, size_t i, uint32_t *cp)
{
    size_t width;

    if (i >= len)
        return false;
    decode_utf16_cp(s, len, i, cp, &width);
    return true;
}

static bool prev_cp(const uint16_t *s, size_t i, uint32_t *cp, size_t *new_i)
{
    if (i == 0)
        return false;

    size_t p = i - 1;
    uint16_t u = s[p];

    if (u >= 0xdc00 && u <= 0xdfff && p > 0 &&
        s[p - 1] >= 0xd800 && s[p - 1] <= 0xdbff) {
        *cp = 0x10000 + ((uint32_t) (s[p - 1] - 0xd800) << 10) + (u - 0xdc00);
        *new_i = p - 1;
        return true;
    }

    *cp = u;
    *new_i = p;
    return true;
}

static bool final_sigma(const uint16_t *s, size_t len, size_t i)
{
    uint32_t cp;
    size_t pos;
    bool before = false;
    bool after = false;

    pos = i;
    while (prev_cp(s, pos, &cp, &pos)) {
        if (fuzzy_is_case_ignorable(cp))
            continue;
        before = fuzzy_is_cased(cp);
        break;
    }

    pos = i + 1;
    while (next_cp(s, len, pos, &cp)) {
        size_t width;

        decode_utf16_cp(s, len, pos, &cp, &width);
        pos += width;
        if (fuzzy_is_case_ignorable(cp))
            continue;
        after = fuzzy_is_cased(cp);
        break;
    }

    return before && !after;
}

bool fuzzy_lower_utf16(const uint16_t *in, size_t len, uint16_t **out, size_t *out_len)
{
    size_t cap = len + 16;
    size_t n = 0;
    size_t i = 0;
    uint16_t *result = malloc((cap + 1) * sizeof(uint16_t));

    if (result == NULL)
        return false;

    while (i < len) {
        uint32_t cp;
        size_t width;
        size_t needed;

        decode_utf16_cp(in, len, i, &cp, &width);

        if (cp == 0x03a3) {
            result[n++] = final_sigma(in, len, i) ? 0x03c2 : 0x03c3;
            i += width;
            continue;
        }

        if (cp >= 'A' && cp <= 'Z') {
            result[n++] = (uint16_t) (cp + ('a' - 'A'));
            i += width;
            continue;
        }

        if (cp < 0x80) {
            result[n++] = (uint16_t) cp;
            i += width;
            continue;
        }

        uint16_t mapped[2];
        int mapped_len = 0;

        if (fuzzy_lower_lookup(cp, mapped, &mapped_len)) {
            needed = n + (size_t) mapped_len;
            if (needed > cap) {
                cap = needed + 16;
                uint16_t *grown = realloc(result, (cap + 1) * sizeof(uint16_t));
                if (grown == NULL) {
                    free(result);
                    return false;
                }
                result = grown;
            }
            for (int j = 0; j < mapped_len; j++)
                result[n++] = mapped[j];
        } else {
            needed = n + width;
            if (needed > cap) {
                cap = needed + 16;
                uint16_t *grown = realloc(result, (cap + 1) * sizeof(uint16_t));
                if (grown == NULL) {
                    free(result);
                    return false;
                }
                result = grown;
            }
            for (size_t j = 0; j < width; j++)
                result[n++] = in[i + j];
        }
        i += width;
    }

    result[n] = 0;
    *out = result;
    *out_len = n;
    return true;
}

void fuzzy_bitflags(const uint16_t *codes, size_t len, uint32_t *flags, bool *has_space)
{
    uint32_t result = 0;
    bool space = false;

    for (size_t i = 0; i < len; i++) {
        uint16_t code = codes[i];

        if (code == 32) {
            space = true;
            result |= FUZZY_SPACE_BIT;
            continue;
        }
        if (code >= 'a' && code <= 'z')
            result |= 1u << (code - 'a');
        else if (code >= '0' && code <= '9')
            result |= 1u << 26;
        else if (code <= 127)
            result |= 1u << 30;
        else
            result |= 1u << 31;
    }

    *flags = result;
    *has_space = space;
}

bool fuzzy_beginnings(const uint16_t *remapped, const uint16_t *lower, size_t len,
                      int **out_beginnings, int *out_count, int first_table[26])
{
    int *beginnings = malloc((len + 1) * sizeof(int));
    int count = 0;
    bool was_upper = false;
    bool was_alnum = false;

    if (beginnings == NULL)
        return false;

    memset(first_table, 0, 26 * sizeof(int));

    for (size_t i = 0; i < len; i++) {
        uint16_t code = remapped[i];
        bool upper = code >= 'A' && code <= 'Z';
        bool alnum = upper || (code >= 'a' && code <= 'z') ||
                     (code >= '0' && code <= '9');
        bool beginning = (upper && !was_upper) || !was_alnum || !alnum;

        was_upper = upper;
        was_alnum = alnum;

        if (!beginning)
            continue;

        beginnings[count++] = (int) i;

        uint16_t lower_code = lower[i];
        if (lower_code >= 'a' && lower_code <= 'z') {
            int slot = lower_code - 'a';
            if (first_table[slot] == 0)
                first_table[slot] = (int) i + 1;
        }
    }

    *out_beginnings = beginnings;
    *out_count = count;
    return true;
}
