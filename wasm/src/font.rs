//! Font helpers: WinAnsi encoding + Base14 Helvetica glyph widths (1/1000 em),
//! plus a FontCtx that wraps parsed TTF resources for CID (Chinese) embedding.
//!
//! MVP = L0/L1: Base14 Helvetica (not embedded), WinAnsiEncoding. Latin copyable.
//! L2: Type0 + CIDFontType2 + Identity-H + ToUnicode for embedded TTF fonts.

use crate::snapshot::FontResource;
use crate::ttf::TtfFont;
use std::collections::HashMap;

/// Adobe Helvetica AFM widths for the WinAnsi (CP1252) byte range 0x00..=0xFF.
/// Values are in 1/1000 em. ASCII range is accurate; high bytes default to 500.
pub const HELVETICA_WIDTHS: [u16; 256] = {
    let mut t = [500u16; 256];
    t[b' ' as usize] = 250;
    t[b'!' as usize] = 333;
    t[b'"' as usize] = 408;
    t[b'#' as usize] = 500;
    t[b'$' as usize] = 500;
    t[b'%' as usize] = 833;
    t[b'&' as usize] = 778;
    t[b'\'' as usize] = 180;
    t[b'(' as usize] = 333;
    t[b')' as usize] = 333;
    t[b'*' as usize] = 500;
    t[b'+' as usize] = 564;
    t[b',' as usize] = 250;
    t[b'-' as usize] = 333;
    t[b'.' as usize] = 250;
    t[b'/' as usize] = 278;
    t[b'0' as usize] = 500;
    t[b'1' as usize] = 500;
    t[b'2' as usize] = 500;
    t[b'3' as usize] = 500;
    t[b'4' as usize] = 500;
    t[b'5' as usize] = 500;
    t[b'6' as usize] = 500;
    t[b'7' as usize] = 500;
    t[b'8' as usize] = 500;
    t[b'9' as usize] = 500;
    t[b':' as usize] = 278;
    t[b';' as usize] = 278;
    t[b'<' as usize] = 564;
    t[b'=' as usize] = 564;
    t[b'>' as usize] = 564;
    t[b'?' as usize] = 444;
    t[b'@' as usize] = 921;
    t[b'A' as usize] = 667;
    t[b'B' as usize] = 667;
    t[b'C' as usize] = 667;
    t[b'D' as usize] = 722;
    t[b'E' as usize] = 667;
    t[b'F' as usize] = 611;
    t[b'G' as usize] = 778;
    t[b'H' as usize] = 722;
    t[b'I' as usize] = 278;
    t[b'J' as usize] = 500;
    t[b'K' as usize] = 667;
    t[b'L' as usize] = 556;
    t[b'M' as usize] = 833;
    t[b'N' as usize] = 722;
    t[b'O' as usize] = 778;
    t[b'P' as usize] = 667;
    t[b'Q' as usize] = 778;
    t[b'R' as usize] = 722;
    t[b'S' as usize] = 667;
    t[b'T' as usize] = 611;
    t[b'U' as usize] = 722;
    t[b'V' as usize] = 667;
    t[b'W' as usize] = 944;
    t[b'X' as usize] = 667;
    t[b'Y' as usize] = 667;
    t[b'Z' as usize] = 611;
    t[b'[' as usize] = 278;
    t[b'\\' as usize] = 278;
    t[b']' as usize] = 278;
    t[b'^' as usize] = 469;
    t[b'_' as usize] = 333;
    t[b'`' as usize] = 333;
    t[b'a' as usize] = 556;
    t[b'b' as usize] = 556;
    t[b'c' as usize] = 500;
    t[b'd' as usize] = 556;
    t[b'e' as usize] = 556;
    t[b'f' as usize] = 278;
    t[b'g' as usize] = 556;
    t[b'h' as usize] = 556;
    t[b'i' as usize] = 222;
    t[b'j' as usize] = 222;
    t[b'k' as usize] = 500;
    t[b'l' as usize] = 222;
    t[b'm' as usize] = 833;
    t[b'n' as usize] = 556;
    t[b'o' as usize] = 556;
    t[b'p' as usize] = 556;
    t[b'q' as usize] = 556;
    t[b'r' as usize] = 333;
    t[b's' as usize] = 500;
    t[b't' as usize] = 278;
    t[b'u' as usize] = 556;
    t[b'v' as usize] = 500;
    t[b'w' as usize] = 722;
    t[b'x' as usize] = 500;
    t[b'y' as usize] = 500;
    t[b'z' as usize] = 500;
    t[b'{' as usize] = 334;
    t[b'|' as usize] = 260;
    t[b'}' as usize] = 334;
    t[b'~' as usize] = 584;
    t
};

/// Encode a Unicode string into WinAnsi (CP1252) bytes. Unsupported chars -> '?'.
pub fn encode_winansi(s: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len());
    for c in s.chars() {
        let b = encode_char_winansi(c).unwrap_or(b'?');
        out.push(b);
    }
    out
}

fn encode_char_winansi(c: char) -> Option<u8> {
    let u = c as u32;
    if u <= 0x7F {
        return Some(u as u8);
    }
    let special = match u {
        0x20AC => 0x80,
        0x201A => 0x82,
        0x0192 => 0x83,
        0x201E => 0x84,
        0x2026 => 0x85,
        0x2020 => 0x86,
        0x2021 => 0x87,
        0x02C6 => 0x88,
        0x2030 => 0x89,
        0x0160 => 0x8A,
        0x2039 => 0x8B,
        0x0152 => 0x8C,
        0x017D => 0x8E,
        0x2018 => 0x91,
        0x2019 => 0x92,
        0x201C => 0x93,
        0x201D => 0x94,
        0x2022 => 0x95,
        0x2013 => 0x96,
        0x2014 => 0x97,
        0x02DC => 0x98,
        0x2122 => 0x99,
        0x0161 => 0x9A,
        0x203A => 0x9B,
        0x0153 => 0x9C,
        0x017E => 0x9E,
        0x0178 => 0x9F,
        _ => 0,
    };
    if special != 0 {
        return Some(special);
    }
    if (0xA0..=0xFF).contains(&u) {
        return Some(u as u8);
    }
    None
}

/// Width of a WinAnsi byte string in 1/1000 em (sum of Helvetica glyph widths).
pub fn text_width_units(bytes: &[u8]) -> u32 {
    bytes.iter().map(|&b| HELVETICA_WIDTHS[b as usize] as u32).sum()
}

// ---- CID font context (embedded TTF) ----

pub struct CidFont {
    pub key: u32, // PDF font key (F{key}); Helvetica = F1, CID fonts start at F2
    // family is encoded in the JS snapshot but unused by the Rust side yet;
    // kept to mirror the wire-format contract.
    #[allow(dead_code)]
    pub family: String,
    pub weight: u16,
    pub italic: u8,
    pub ttf: TtfFont,
    pub used_gids: std::cell::RefCell<Vec<u16>>,
    pub gid_to_unicode: HashMap<u16, u32>, // reverse cmap for ToUnicode (built lazily)
    pub used_gid_to_unicode: std::cell::RefCell<HashMap<u16, u32>>,
    pub subset_old_to_new: std::cell::RefCell<Option<HashMap<u16, u16>>>,
}

pub struct FontCtx {
    pub cid: Vec<CidFont>,
    /// lowercase family -> indices into cid (may hold multiple weights/styles)
    pub by_family: HashMap<String, Vec<usize>>,
}

fn score_cid_font(cf: &CidFont, weight: u16, italic: u8) -> i32 {
    let mut score = 1;
    if cf.weight == weight {
        score += 4;
    } else if (cf.weight >= 700) == (weight >= 700) {
        score += 2;
    }
    if cf.italic == italic {
        score += 2;
    }
    score
}

fn prefers_cid_fallback_family(family: &str) -> bool {
    let fam_lc = family.trim().trim_matches('"').trim_matches('\'').to_lowercase();
    matches!(
        fam_lc.as_str(),
        "-apple-system"
            | "blinkmacsystemfont"
            | "system-ui"
            | "ui-sans-serif"
            | "sans-serif"
            | "segoe ui"
            | "roboto"
            | "ubuntu"
            | "cantarell"
            | "noto sans"
            | "helvetica neue"
            | "pingfang sc"
            | "hiragino sans gb"
            | "microsoft yahei"
            | "microsoft yahei ui"
            | "wenquanyi micro hei"
            | "source han sans sc"
            | "sourcehansanssc-regular"
            | "arial"
    )
}

impl FontCtx {
    pub fn build(resources: &[FontResource]) -> Result<FontCtx, String> {
        let mut cid: Vec<CidFont> = Vec::new();
        let mut by_family: HashMap<String, Vec<usize>> = HashMap::new();
        for r in resources {
            let ttf = match TtfFont::parse(&r.bytes) {
                Ok(t) => t,
                Err(_) => continue, // skip unparseable font
            };
            let key = 2 + cid.len() as u32;
            // Build reverse cmap (gid -> first unicode). Bounded by cmap size.
            let mut rev: HashMap<u16, u32> = HashMap::new();
            for (&cp, &gid) in ttf.cmap.iter() {
                rev.entry(gid).or_insert(cp);
            }
            let fam_lc = r.family.to_lowercase();
            let idx = cid.len();
            by_family.entry(fam_lc).or_default().push(idx);
            cid.push(CidFont {
                key,
                family: r.family.clone(),
                weight: r.weight,
                italic: r.style,
                ttf,
                used_gids: std::cell::RefCell::new(Vec::new()),
                gid_to_unicode: rev,
                used_gid_to_unicode: std::cell::RefCell::new(HashMap::new()),
                subset_old_to_new: std::cell::RefCell::new(None),
            });
        }
        Ok(FontCtx { cid, by_family })
    }

    /// Select a CID font for a node font family. Returns None => use Helvetica.
    /// Matches by lowercase family; among matches prefers exact weight/italic.
    pub fn select(&self, family: &str, weight: u16, italic: u8) -> Option<&CidFont> {
        let fam_lc = family.to_lowercase();
        let idxs = self.by_family.get(&fam_lc)?;
        let mut best = idxs[0];
        let mut best_score = i32::MIN;
        for &i in idxs.iter() {
            let cf = &self.cid[i];
            let score = score_cid_font(cf, weight, italic);
            if score > best_score {
                best_score = score;
                best = i;
            }
        }
        Some(&self.cid[best])
    }

    /// Select the first registered CID font (for header/footer fallback).
    pub fn first_cid(&self) -> Option<&CidFont> {
        self.cid.first()
    }

    /// Shape a text run into glyphs with per-glyph font fallback.
    ///
    /// For each char: use `primary_idx` when it has the glyph; otherwise scan
    /// the other registered fonts (registration order) for the first that does.
    /// If none has it, fall back to the primary's `.notdef` (gid 0), preserving
    /// the previous single-font behavior. When `record` is true, the resolved
    /// gid is registered into the font that supplies it (used for subsetting);
    /// this must run during the collect pass, before `prepare_subset_maps()`.
    pub fn shape(&self, primary_idx: usize, text: &str, record: bool) -> Vec<ShapedGlyph> {
        let mut out = Vec::with_capacity(text.chars().count());
        let primary_idx = primary_idx.min(self.cid.len().saturating_sub(1));
        for c in text.chars() {
            let cp = c as u32;
            let mut font_idx = primary_idx;
            let mut gid = self.cid[primary_idx].ttf.gid_for(cp);
            if gid == 0 {
                for (i, cf) in self.cid.iter().enumerate() {
                    if i == primary_idx {
                        continue;
                    }
                    let g = cf.ttf.gid_for(cp);
                    if g != 0 {
                        font_idx = i;
                        gid = g;
                        break;
                    }
                }
            }
            let width_1000 = self.cid[font_idx].ttf.width_1000(gid);
            if record {
                let mut used = self.cid[font_idx].used_gids.borrow_mut();
                if !used.contains(&gid) {
                    used.push(gid);
                }
                if gid != 0 {
                    self.cid[font_idx]
                        .used_gid_to_unicode
                        .borrow_mut()
                        .entry(gid)
                        .or_insert(cp);
                }
            }
            out.push(ShapedGlyph {
                font_idx,
                old_gid: gid,
                width_1000,
                is_space: c == ' ',
            });
        }
        out
    }

    /// Select the most compatible CID font across all registered resources.
    pub fn fallback_cid(&self, weight: u16, italic: u8) -> Option<&CidFont> {
        let mut best_idx = None;
        let mut best_score = i32::MIN;
        for (idx, cf) in self.cid.iter().enumerate() {
            let score = score_cid_font(cf, weight, italic);
            if score > best_score {
                best_score = score;
                best_idx = Some(idx);
            }
        }
        best_idx.map(|idx| &self.cid[idx])
    }

    /// Prefer a registered CID font for common UI/CJK family stacks so browser and
    /// PDF text stay on the same embedded font instead of drifting to Helvetica.
    pub fn prefers_cid_fallback(&self, family: &str) -> bool {
        !self.cid.is_empty() && prefers_cid_fallback_family(family)
    }

    pub fn prepare_subset_maps(&self) {
        for cf in self.cid.iter() {
            let mut used = cf.used_gids.borrow().clone();
            if !used.contains(&0) {
                used.push(0);
            }
            used.sort_unstable();
            used.dedup();
            *cf.used_gids.borrow_mut() = used.clone();
            let map: HashMap<u16, u16> = used
                .into_iter()
                .enumerate()
                .map(|(new_gid, old_gid)| (old_gid, new_gid as u16))
                .collect();
            *cf.subset_old_to_new.borrow_mut() = Some(map);
        }
    }
}

impl CidFont {
    pub fn subset_gid(&self, old_gid: u16) -> u16 {
        self.subset_old_to_new
            .borrow()
            .as_ref()
            .and_then(|m| m.get(&old_gid).copied())
            .unwrap_or(old_gid)
    }

    pub fn actual_unicode_for_gid(&self, old_gid: u16) -> Option<u32> {
        self.used_gid_to_unicode
            .borrow()
            .get(&old_gid)
            .copied()
            .or_else(|| self.gid_to_unicode.get(&old_gid).copied())
    }
}

/// One shaped glyph after per-glyph font fallback. `font_idx` indexes into
/// `FontCtx::cid`; `old_gid` is the gid in that font (subset-mapped at draw
/// time); `width_1000` is its advance in 1/1000 em (font-independent units).
pub struct ShapedGlyph {
    pub font_idx: usize,
    pub old_gid: u16,
    pub width_1000: u32,
    pub is_space: bool,
}

pub struct EncodedCidRun {
    pub font_idx: usize,
    pub bytes: Vec<u8>,
    pub width_1000: u32,
}

pub fn encode_cid_with_fallback(
    fontctx: &FontCtx,
    primary_idx: usize,
    text: &str,
    record: bool,
) -> Vec<EncodedCidRun> {
    let glyphs = fontctx.shape(primary_idx, text, record);
    if glyphs.is_empty() {
        return Vec::new();
    }
    let mut runs: Vec<EncodedCidRun> = Vec::new();
    for glyph in glyphs {
        let draw_gid = fontctx.cid[glyph.font_idx].subset_gid(glyph.old_gid);
        if let Some(last) = runs.last_mut() {
            if last.font_idx == glyph.font_idx {
                last.bytes.push((draw_gid >> 8) as u8);
                last.bytes.push((draw_gid & 0xff) as u8);
                last.width_1000 += glyph.width_1000;
                continue;
            }
        }
        runs.push(EncodedCidRun {
            font_idx: glyph.font_idx,
            bytes: vec![(draw_gid >> 8) as u8, (draw_gid & 0xff) as u8],
            width_1000: glyph.width_1000,
        });
    }
    runs
}

/// Result of encoding a text run for a CID font: glyph id bytes (big-endian,
/// 2 bytes per gid for Identity-H) + total width in 1/1000 em.
#[allow(dead_code)]
pub fn encode_cid(cf: &CidFont, text: &str) -> (Vec<u8>, u32) {
    let mut bytes = Vec::with_capacity(text.chars().count() * 2);
    let mut width = 0u32;
    let mut used = cf.used_gids.borrow_mut();
    for c in text.chars() {
        let cp = c as u32;
        let old_gid = cf.ttf.gid_for(c as u32);
        let draw_gid = cf.subset_gid(old_gid);
        bytes.push((draw_gid >> 8) as u8);
        bytes.push((draw_gid & 0xff) as u8);
        width += cf.ttf.width_1000(old_gid);
        if !used.contains(&old_gid) {
            used.push(old_gid);
        }
        if old_gid != 0 {
            cf.used_gid_to_unicode
                .borrow_mut()
                .entry(old_gid)
                .or_insert(cp);
        }
    }
    (bytes, width)
}
