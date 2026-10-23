#define _LARGEFILE64_SOURCE
#include <assert.h>
#include <string.h>
#include <zlib.h>

int main(void) {
    const unsigned char first[] = "Lovelies ";
    const unsigned char second[] = "verified decoder";
    const unsigned char combined[] = "Lovelies verified decoder";
    uLong a = crc32(0, first, sizeof(first) - 1);
    uLong b = crc32(0, second, sizeof(second) - 1);
    uLong expected = crc32(0, combined, sizeof(combined) - 1);
    assert(crc32_combine64(a, b, sizeof(second) - 1) == expected);
    assert(crc32_combine_op(a, b, crc32_combine_gen64(sizeof(second) - 1)) == expected);
    assert(crc32_combine64(a, 0, 0) == a);
    assert(crc32_combine64(a, b, -1) == 0);
    assert(crc32_combine_gen64(-1) == 0);
    assert(crc32_combine(a, b, -1) == 0);
    assert(crc32_combine_gen(-1) == 0);
    unsigned char compressed[128], decoded[sizeof(combined)];
    uLongf compressed_size = sizeof(compressed), decoded_size = sizeof(decoded);
    assert(compress(compressed, &compressed_size, combined, sizeof(combined)) == Z_OK);
    assert(uncompress(decoded, &decoded_size, compressed, compressed_size) == Z_OK);
    assert(decoded_size == sizeof(combined));
    assert(memcmp(decoded, combined, sizeof(combined)) == 0);
    return 0;
}
