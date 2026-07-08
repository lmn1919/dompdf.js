//! Pure-Rust DEFLATE compressor (fixed Huffman + LZ77).
//!
//! Implements RFC 1951 deflate compression using fixed Huffman codes.
//! No third-party dependencies - std only.
//!
//! Strategy: single block, BFINAL=1, BTYPE=01 (fixed Huffman).
//! LZ77 with hash-chain matching (32K window), greedy match selection.
//! Falls back to stored blocks when compression fails to shrink data.

const MIN_MATCH: usize = 3;
const MAX_MATCH: usize = 258;
const WINDOW_SIZE: usize = 32768;
const HASH_BITS: u32 = 15;
const HASH_SIZE: usize = 1 << HASH_BITS;
const MAX_CHAIN: usize = 128;

// Length codes 257-285: base lengths and extra bits (RFC 1951 §3.2.5).
const LENGTH_BASE: [u16; 29] = [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
    163, 195, 227, 258,
];
const LENGTH_EXTRA: [u8; 29] = [
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];

// Distance codes 0-29: base distances and extra bits.
const DIST_BASE: [u16; 30] = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537,
    2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA: [u8; 30] = [
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13,
    13,
];

// Fixed Huffman code lengths for literal/length symbols (RFC 1951 §3.2.6):
// 0-143: 8 bits, 144-255: 9 bits, 256-279: 7 bits, 280-287: 8 bits.
const FIXED_LITERAL_BITS: [u8; 288] = {
    let mut a = [0u8; 288];
    let mut i = 0;
    while i < 144 {
        a[i] = 8;
        i += 1;
    }
    while i < 256 {
        a[i] = 9;
        i += 1;
    }
    while i < 280 {
        a[i] = 7;
        i += 1;
    }
    while i < 288 {
        a[i] = 8;
        i += 1;
    }
    a
};

/// Precomputed fixed Huffman codes for literal/length symbols.
/// Each entry packs (code_value, bit_length) as (code << 8 | len).
fn build_fixed_codes() -> [u32; 288] {
    // Build canonical Huffman codes from bit lengths (RFC 1951 §3.2.2).
    let bl_count = |bits: u8| -> u32 {
        FIXED_LITERAL_BITS.iter().filter(|&&b| b == bits).count() as u32
    };
    let mut next_code = [0u32; 16];
    let mut code: u32 = 0;
    for bits in 1..=15u8 {
        code = (code + bl_count(bits - 1)) << 1;
        next_code[bits as usize] = code;
    }
    let mut codes = [0u32; 288];
    for n in 0..288 {
        let len = FIXED_LITERAL_BITS[n];
        if len != 0 {
            codes[n] = (next_code[len as usize] << 8) | (len as u32);
            next_code[len as usize] += 1;
        }
    }
    codes
}

/// Bit writer that emits bits into a byte buffer, LSB-first packing.
/// Per RFC 1951: extra bits and block header bits are packed LSB-first
/// (first bit = LSB of value). Huffman codes are MSB-first and must be
/// bit-reversed before packing.
struct BitWriter {
    buf: Vec<u8>,
    bitbuf: u32,
    bitcount: u8,
}

impl BitWriter {
    fn new() -> Self {
        Self {
            buf: Vec::with_capacity(4096),
            bitbuf: 0,
            bitcount: 0,
        }
    }

    /// Write `n` bits of `bits`, LSB-first (first bit = LSB of `bits`).
    /// Used for extra bits and block header bits - NO reversal.
    fn write_bits(&mut self, bits: u32, n: u8) {
        self.bitbuf |= (bits & ((1u32 << n) - 1)) << self.bitcount;
        self.bitcount += n;
        while self.bitcount >= 8 {
            self.buf.push((self.bitbuf & 0xFF) as u8);
            self.bitbuf >>= 8;
            self.bitcount -= 8;
        }
    }

    /// Write a Huffman code. `packed` = (code_value << 8) | bit_length.
    /// The code value has MSB = first bit to emit. We reverse the bits to
    /// pack them LSB-first into the stream.
    fn write_code(&mut self, packed: u32) {
        let code = packed >> 8;
        let len = (packed & 0xFF) as u8;
        let reversed = reverse_bits(code, len);
        self.write_bits(reversed, len);
    }

    /// Write a fixed distance code (5 bits, MSB-first). The symbol value
    /// itself IS the code (canonical), so we must reverse it.
    fn write_dist(&mut self, sym: u32) {
        let reversed = reverse_bits(sym, 5);
        self.write_bits(reversed, 5);
    }

    fn flush(&mut self) {
        if self.bitcount > 0 {
            self.buf.push((self.bitbuf & 0xFF) as u8);
            self.bitbuf = 0;
            self.bitcount = 0;
        }
    }
}

/// Reverse the low `n` bits of `v` (bit 0 <-> bit n-1, etc.).
fn reverse_bits(mut v: u32, n: u8) -> u32 {
    let mut r = 0u32;
    for _ in 0..n {
        r = (r << 1) | (v & 1);
        v >>= 1;
    }
    r
}

/// Find the length code index for a match length (3-258).
/// Returns (symbol, base_length, extra_bits).
fn length_code(len: usize) -> (u32, u16, u8) {
    let len = len as u16;
    for i in 0..29 {
        let next_base = if i + 1 < 29 { LENGTH_BASE[i + 1] } else { 259 };
        if len < next_base {
            return (257 + i as u32, LENGTH_BASE[i], LENGTH_EXTRA[i]);
        }
    }
    (285, 258, 0)
}

/// Find the distance code index for a match distance (1-32768).
/// Returns (symbol, base_distance, extra_bits).
fn distance_code(dist: usize) -> (u32, u16, u8) {
    let dist = dist as u16;
    for i in 0..30 {
        let next_base = if i + 1 < 30 { DIST_BASE[i + 1] } else { 32769 };
        if dist < next_base {
            return (i as u32, DIST_BASE[i], DIST_EXTRA[i]);
        }
    }
    (29, 24577, 13)
}

/// Compute hash of 3 bytes at position `pos` in `data`.
#[inline]
fn hash3(data: &[u8], pos: usize) -> usize {
    let h = (data[pos] as u32).wrapping_mul(0x9E3779B1)
        ^ ((data[pos + 1] as u32).wrapping_mul(0x85EBCA6B) << 1)
        ^ ((data[pos + 2] as u32).wrapping_mul(0xC2B2AE35) << 2);
    (h >> (32 - HASH_BITS)) as usize
}

/// LZ77 match finder using hash chains.
struct MatchFinder {
    head: Vec<i32>,
    prev: Vec<i32>,
}

impl MatchFinder {
    fn new() -> Self {
        Self {
            head: vec![-1; HASH_SIZE],
            prev: vec![-1; WINDOW_SIZE],
        }
    }

    fn insert(&mut self, data: &[u8], pos: usize) {
        if pos + MIN_MATCH > data.len() {
            return;
        }
        let h = hash3(data, pos) % HASH_SIZE;
        self.prev[pos % WINDOW_SIZE] = self.head[h];
        self.head[h] = pos as i32;
    }

    fn find_best_match(&self, data: &[u8], pos: usize) -> Option<(usize, usize)> {
        if pos + MIN_MATCH > data.len() {
            return None;
        }
        let h = hash3(data, pos) % HASH_SIZE;
        let max_len = (data.len() - pos).min(MAX_MATCH);
        if max_len < MIN_MATCH {
            return None;
        }

        let limit = pos.saturating_sub(WINDOW_SIZE);
        let mut best_len = 0usize;
        let mut best_dist = 0usize;
        let mut chain = 0;
        let mut cur = self.head[h];

        while cur >= 0 && chain < MAX_CHAIN {
            let cur_pos = cur as usize;
            if cur_pos < limit || cur_pos >= pos {
                break;
            }
            let dist = pos - cur_pos;
            if dist > WINDOW_SIZE {
                break;
            }

            // Quick filter: if we already have a match, check the byte at
            // best_len position to skip obviously worse candidates.
            if best_len >= MIN_MATCH {
                let check_pos = pos + best_len;
                let check_cur = cur_pos + best_len;
                if check_pos >= data.len() || check_cur >= data.len() {
                    break;
                }
                if data[check_pos] != data[check_cur] {
                    cur = self.prev[cur_pos % WINDOW_SIZE];
                    chain += 1;
                    continue;
                }
            }

            // Count matching bytes.
            let mut len = 0;
            while len < max_len && data[cur_pos + len] == data[pos + len] {
                len += 1;
            }

            if len > best_len || (len == best_len && dist < best_dist) {
                best_len = len;
                best_dist = dist;
                if best_len >= max_len {
                    break;
                }
            }

            cur = self.prev[cur_pos % WINDOW_SIZE];
            chain += 1;
        }

        if best_len >= MIN_MATCH {
            Some((best_len, best_dist))
        } else {
            None
        }
    }
}

/// Compress data using DEFLATE with fixed Huffman codes.
/// Returns the compressed deflate stream (without zlib header/trailer).
/// Falls back to stored blocks if compression doesn't help.
fn deflate_fixed(data: &[u8]) -> Vec<u8> {
    if data.is_empty() {
        return vec![0x01, 0x00, 0x00, 0xFF, 0xFF];
    }

    let fixed_codes = build_fixed_codes();
    let mut writer = BitWriter::new();
    let mut finder = MatchFinder::new();

    // Block header: BFINAL=1, BTYPE=01 (fixed Huffman).
    // BFINAL is 1 bit, BTYPE is 2 bits. Packed LSB-first: BFINAL=1, BTYPE=01.
    writer.write_bits(0b011, 3); // BFINAL=1 (bit 0), BTYPE=01 (bits 1-2)

    let n = data.len();

    // Insert first MIN_MATCH-1 positions (no match possible yet).
    let warmup = (MIN_MATCH - 1).min(n);
    for i in 0..warmup {
        writer.write_code(fixed_codes[data[i] as usize]);
        finder.insert(data, i);
    }
    let mut pos = warmup;

    while pos < n {
        let match_result = finder.find_best_match(data, pos);

        match match_result {
            Some((len, dist)) => {
                // Emit length code.
                let (sym, base, extra_bits) = length_code(len);
                writer.write_code(fixed_codes[sym as usize]);
                if extra_bits > 0 {
                    writer.write_bits((len - base as usize) as u32, extra_bits);
                }
                // Emit distance code.
                let (dsym, dbase, dextra) = distance_code(dist);
                writer.write_dist(dsym);
                if dextra > 0 {
                    writer.write_bits((dist - dbase as usize) as u32, dextra);
                }

                // Insert all positions in the match.
                for i in 0..len {
                    finder.insert(data, pos + i);
                }
                pos += len;
            }
            None => {
                // Literal byte.
                writer.write_code(fixed_codes[data[pos] as usize]);
                finder.insert(data, pos);
                pos += 1;
            }
        }
    }

    // End of block (symbol 256).
    writer.write_code(fixed_codes[256]);
    writer.flush();

    // If compression didn't help, fall back to stored.
    if writer.buf.len() >= data.len() {
        return stored_blocks(data);
    }

    writer.buf
}

/// Encode data as stored (uncompressed) deflate blocks.
fn stored_blocks(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + data.len() / 0xFFFF * 5 + 5);
    let mut i = 0;
    let n = data.len();
    while i < n {
        let chunk = (n - i).min(0xFFFF);
        let is_final = i + chunk >= n;
        out.push(if is_final { 0x01 } else { 0x00 });
        let len = chunk as u16;
        out.extend_from_slice(&len.to_le_bytes());
        out.extend_from_slice(&(!len).to_le_bytes());
        out.extend_from_slice(&data[i..i + chunk]);
        i += chunk;
    }
    out
}

/// Wrap `data` in a zlib stream with real DEFLATE compression.
/// Falls back to stored blocks if compression doesn't reduce size.
/// This replaces `zlib_store` when `compress` is enabled.
pub fn zlib_deflate(data: &[u8]) -> Vec<u8> {
    let deflated = deflate_fixed(data);

    // Only use compressed version if it's actually smaller than stored.
    let stored = stored_blocks(data);
    let best = if deflated.len() < stored.len() {
        deflated
    } else {
        stored
    };

    let mut out = Vec::with_capacity(best.len() + 6);
    // zlib header: CMF=0x78 (deflate, 32K window), FLG=0x9C (default level).
    // (CMF*256 + FLG) % 31 == 0: 0x7800 + 0x9C = 0x789C, 30876 % 31 = 0.
    out.push(0x78);
    out.push(0x9C);
    out.extend_from_slice(&best);
    out.extend_from_slice(&adler32(data).to_be_bytes());
    out
}

fn adler32(data: &[u8]) -> u32 {
    const MOD: u32 = 65521;
    let mut a: u32 = 1;
    let mut b: u32 = 0;
    for &byte in data {
        a = (a + byte as u32) % MOD;
        b = (b + a) % MOD;
    }
    (b << 16) | a
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_empty() {
        let result = zlib_deflate(&[]);
        // zlib header + empty stored block + adler32
        assert_eq!(&result[..2], &[0x78, 0x9C]);
    }

    #[test]
    fn test_simple_text() {
        let input = b"BT /F1 12 Tf 100 700 Td (Hello World) Tj ET".repeat(50);
        let compressed = zlib_deflate(&input);
        assert!(compressed.len() < input.len());
    }
}
