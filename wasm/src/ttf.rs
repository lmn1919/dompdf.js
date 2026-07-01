//! Minimal TrueType font parser (pure std).
//!
//! Extracts just enough to embed a TTF as a PDF CIDFontType2 (Type0) with
//! Identity-H encoding and a ToUnicode CMap:
//!   - `head`: unitsPerEm, indexToLocFormat
//!   - `maxp`: numGlyphs
//!   - `hhea`: numberOfHMetrics
//!   - `hmtx`: per-glyph advance widths
//!   - `cmap`: unicode -> glyph id (formats 0, 4, 6, 12)
//!   - `loca` + `glyf`: glyph outlines (used only for subsetting; see subset())
//!
//! No third-party libs. Tables are read by scanning the table directory; we do
//! not assume a fixed table order.

use std::collections::{BTreeSet, HashMap};

pub struct TtfFont {
    pub units_per_em: u16,
    pub num_glyphs: u16,
    pub index_to_loc_format: i16, // 0 = short, 1 = long
    // Parsed from hhea; used only during parse() to walk hmtx. Retained for
    // completeness of the font model.
    #[allow(dead_code)]
    pub number_of_h_metrics: u16,
    pub cmap: HashMap<u32, u16>, // unicode codepoint -> glyph id
    pub advance_units: Vec<u16>, // per gid (raw font units)
    pub left_side_bearings: Vec<i16>, // per gid
    pub raw: Vec<u8>,            // original bytes (whole-font embed fallback)
    pub bbox: [i16; 4],          // xMin, yMin, xMax, yMax (font units)
    pub ascent: i16,             // hhea ascent (font units)
    pub descent: i16,            // hhea descent (font units)
    // table locations for subsetting
    pub tables: HashMap<[u8; 4], (usize, usize)>, // tag -> (offset, length)
}

fn rd_u16(b: &[u8], o: usize) -> Option<u16> {
    b.get(o..o + 2)
        .map(|s| u16::from_be_bytes([s[0], s[1]]))
}
fn rd_i16(b: &[u8], o: usize) -> Option<i16> {
    b.get(o..o + 2).map(|s| i16::from_be_bytes([s[0], s[1]]))
}
fn rd_u32(b: &[u8], o: usize) -> Option<u32> {
    b.get(o..o + 4)
        .map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
}

fn wr_u16(b: &mut [u8], o: usize, v: u16) -> Option<()> {
    let dst = b.get_mut(o..o + 2)?;
    dst.copy_from_slice(&v.to_be_bytes());
    Some(())
}

fn wr_i16(b: &mut [u8], o: usize, v: i16) -> Option<()> {
    let dst = b.get_mut(o..o + 2)?;
    dst.copy_from_slice(&v.to_be_bytes());
    Some(())
}

fn wr_u32(b: &mut [u8], o: usize, v: u32) -> Option<()> {
    let dst = b.get_mut(o..o + 4)?;
    dst.copy_from_slice(&v.to_be_bytes());
    Some(())
}

fn push_u16(out: &mut Vec<u8>, v: u16) {
    out.extend_from_slice(&v.to_be_bytes());
}

fn push_i16(out: &mut Vec<u8>, v: i16) {
    out.extend_from_slice(&v.to_be_bytes());
}

fn push_u32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_be_bytes());
}

fn align4(n: usize) -> usize {
    (n + 3) & !3
}

fn table_checksum(data: &[u8]) -> u32 {
    let mut sum = 0u32;
    let mut i = 0usize;
    while i < data.len() {
        let mut word = [0u8; 4];
        let end = (i + 4).min(data.len());
        word[..end - i].copy_from_slice(&data[i..end]);
        sum = sum.wrapping_add(u32::from_be_bytes(word));
        i += 4;
    }
    sum
}

fn component_arg_bytes(flags: u16) -> usize {
    if flags & 0x0001 != 0 { 4 } else { 2 }
}

fn component_transform_bytes(flags: u16) -> usize {
    if flags & 0x0008 != 0 {
        2
    } else if flags & 0x0040 != 0 {
        4
    } else if flags & 0x0080 != 0 {
        8
    } else {
        0
    }
}

impl TtfFont {
    pub fn parse(bytes: &[u8]) -> Result<TtfFont, String> {
        if bytes.len() < 12 {
            return Err("ttf too small".into());
        }
        let num_tables = rd_u16(bytes, 4).ok_or("numTables")? as usize;
        if bytes.len() < 12 + num_tables * 16 {
            return Err("ttf directory truncated".into());
        }
        let mut tables: HashMap<[u8; 4], (usize, usize)> = HashMap::new();
        for i in 0..num_tables {
            let base = 12 + i * 16;
            let tag = [bytes[base], bytes[base + 1], bytes[base + 2], bytes[base + 3]];
            let offset = rd_u32(bytes, base + 8).ok_or("offset")? as usize;
            let length = rd_u32(bytes, base + 12).ok_or("length")? as usize;
            tables.insert(tag, (offset, length));
        }

        // head
        let (head_off, _) = *tables.get(b"head").ok_or("no head")?;
        if head_off + 54 > bytes.len() {
            return Err("head truncated".into());
        }
        let units_per_em = rd_u16(bytes, head_off + 18).ok_or("upem")?;
        let index_to_loc_format = rd_i16(bytes, head_off + 50).ok_or("locfmt")?;
        let bbox = [
            rd_i16(bytes, head_off + 36).unwrap_or(0),
            rd_i16(bytes, head_off + 38).unwrap_or(0),
            rd_i16(bytes, head_off + 40).unwrap_or(0),
            rd_i16(bytes, head_off + 42).unwrap_or(0),
        ];

        // maxp
        let (maxp_off, _) = *tables.get(b"maxp").ok_or("no maxp")?;
        let num_glyphs = rd_u16(bytes, maxp_off + 4).ok_or("numGlyphs")?;

        // hhea
        let (hhea_off, _) = *tables.get(b"hhea").ok_or("no hhea")?;
        let number_of_h_metrics = rd_u16(bytes, hhea_off + 34).ok_or("numHmetrics")?;
        let ascent = rd_i16(bytes, hhea_off + 4).unwrap_or(0);
        let descent = rd_i16(bytes, hhea_off + 6).unwrap_or(0);

        // hmtx
        let mut advance_units = vec![0u16; num_glyphs as usize];
        let mut left_side_bearings = vec![0i16; num_glyphs as usize];
        if let Some(&(hmtx_off, _)) = tables.get(b"hmtx") {
            let mut last_advance: u16 = 0;
            for g in 0..num_glyphs as usize {
                if g < number_of_h_metrics as usize {
                    let o = hmtx_off + g * 4;
                    let adv = rd_u16(bytes, o).unwrap_or(0);
                    let lsb = rd_i16(bytes, o + 2).unwrap_or(0);
                    advance_units[g] = adv;
                    left_side_bearings[g] = lsb;
                    last_advance = adv;
                } else {
                    advance_units[g] = last_advance;
                    let o = hmtx_off + number_of_h_metrics as usize * 4
                        + (g - number_of_h_metrics as usize) * 2;
                    left_side_bearings[g] = rd_i16(bytes, o).unwrap_or(0);
                }
            }
        }

        // cmap
        let cmap = parse_cmap(bytes, tables.get(b"cmap").ok_or("no cmap")?)?;

        Ok(TtfFont {
            units_per_em,
            num_glyphs,
            index_to_loc_format,
            number_of_h_metrics,
            cmap,
            advance_units,
            left_side_bearings,
            raw: bytes.to_vec(),
            bbox,
            ascent,
            descent,
            tables,
        })
    }

    pub fn gid_for(&self, cp: u32) -> u16 {
        *self.cmap.get(&cp).unwrap_or(&0)
    }

    /// Advance width in 1/1000 em (PDF W array units).
    pub fn width_1000(&self, gid: u16) -> u32 {
        let g = (gid as usize).min(self.advance_units.len().saturating_sub(1));
        let raw = self.advance_units[g] as u32;
        if self.units_per_em == 0 {
            raw
        } else {
            // Round to nearest rather than truncate: truncation drops up to ~1
            // unit per glyph, which accumulates into a visible per-line narrowing.
            let upem = self.units_per_em as u32;
            (raw * 1000 + upem / 2) / upem
        }
    }

    /// Left side bearing of a glyph in 1/1000 em.
    #[allow(dead_code)]
    pub fn lsb_1000(&self, gid: u16) -> i32 {
        let g = (gid as usize).min(self.left_side_bearings.len().saturating_sub(1));
        self.to_1000(self.left_side_bearings[g] as i32)
    }

    fn to_1000(&self, v: i32) -> i32 {
        if self.units_per_em == 0 {
            v
        } else {
            // Symmetric rounding (toward nearest, halves away from zero).
            let upem = self.units_per_em as i32;
            let half = upem / 2;
            if v >= 0 {
                (v * 1000 + half) / upem
            } else {
                -((-v * 1000 + half) / upem)
            }
        }
    }

    /// FontBBox in 1/1000 em: [xMin, yMin, xMax, yMax].
    pub fn bbox_1000(&self) -> [i32; 4] {
        [
            self.to_1000(self.bbox[0] as i32),
            self.to_1000(self.bbox[1] as i32),
            self.to_1000(self.bbox[2] as i32),
            self.to_1000(self.bbox[3] as i32),
        ]
    }

    pub fn ascent_1000(&self) -> i32 {
        self.to_1000(self.ascent as i32)
    }

    pub fn descent_1000(&self) -> i32 {
        self.to_1000(self.descent as i32)
    }

    fn table_bytes(&self, tag: &[u8; 4]) -> Option<&[u8]> {
        let (off, len) = *self.tables.get(tag)?;
        self.raw.get(off..off + len)
    }

    fn loca_offsets(&self) -> Result<Vec<u32>, String> {
        let loca = self.table_bytes(b"loca").ok_or("no loca")?;
        let count = self.num_glyphs as usize + 1;
        let mut out = Vec::with_capacity(count);
        if self.index_to_loc_format == 0 {
            if loca.len() < count * 2 {
                return Err("loca truncated".into());
            }
            for i in 0..count {
                let v = rd_u16(loca, i * 2).ok_or("loca short")? as u32 * 2;
                out.push(v);
            }
        } else {
            if loca.len() < count * 4 {
                return Err("loca truncated".into());
            }
            for i in 0..count {
                out.push(rd_u32(loca, i * 4).ok_or("loca long")?);
            }
        }
        Ok(out)
    }

    fn glyph_bytes<'a>(&'a self, loca: &[u32], gid: u16) -> Result<&'a [u8], String> {
        let glyf = self.table_bytes(b"glyf").ok_or("no glyf")?;
        let g = gid as usize;
        if g + 1 >= loca.len() {
            return Err("glyph id OOB".into());
        }
        let start = loca[g] as usize;
        let end = loca[g + 1] as usize;
        if start > end || end > glyf.len() {
            return Err("glyf slice OOB".into());
        }
        Ok(&glyf[start..end])
    }

    fn collect_composite_glyphs(
        &self,
        gid: u16,
        loca: &[u32],
        keep: &mut BTreeSet<u16>,
    ) -> Result<(), String> {
        if gid >= self.num_glyphs {
            return Err("glyph id OOB".into());
        }
        if !keep.insert(gid) {
            return Ok(());
        }
        let glyph = self.glyph_bytes(loca, gid)?;
        if glyph.len() < 10 {
            return Ok(());
        }
        let contours = rd_i16(glyph, 0).ok_or("glyph header")?;
        if contours >= 0 {
            return Ok(());
        }
        let mut pos = 10usize;
        loop {
            if pos + 4 > glyph.len() {
                return Err("composite glyph truncated".into());
            }
            let flags = rd_u16(glyph, pos).ok_or("composite flags")?;
            let comp_gid = rd_u16(glyph, pos + 2).ok_or("component gid")?;
            self.collect_composite_glyphs(comp_gid, loca, keep)?;
            pos += 4 + component_arg_bytes(flags) + component_transform_bytes(flags);
            if flags & 0x0020 == 0 {
                if flags & 0x0100 != 0 {
                    if pos + 2 > glyph.len() {
                        return Err("composite instructions len".into());
                    }
                    let ilen = rd_u16(glyph, pos).ok_or("instruction len")? as usize;
                    if pos + 2 + ilen > glyph.len() {
                        return Err("composite instructions truncated".into());
                    }
                }
                break;
            }
        }
        Ok(())
    }

    fn rewrite_glyph(
        &self,
        glyph: &[u8],
        old_to_new: &HashMap<u16, u16>,
    ) -> Result<Vec<u8>, String> {
        if glyph.len() < 10 {
            return Ok(glyph.to_vec());
        }
        let contours = rd_i16(glyph, 0).ok_or("glyph header")?;
        if contours >= 0 {
            return Ok(glyph.to_vec());
        }
        let mut out = glyph.to_vec();
        let mut pos = 10usize;
        loop {
            if pos + 4 > out.len() {
                return Err("composite glyph truncated".into());
            }
            let flags = rd_u16(&out, pos).ok_or("composite flags")?;
            let old_gid = rd_u16(&out, pos + 2).ok_or("component gid")?;
            let new_gid = *old_to_new.get(&old_gid).ok_or("missing remapped component gid")?;
            wr_u16(&mut out, pos + 2, new_gid).ok_or("write component gid")?;
            pos += 4 + component_arg_bytes(flags) + component_transform_bytes(flags);
            if flags & 0x0020 == 0 {
                if flags & 0x0100 != 0 {
                    if pos + 2 > out.len() {
                        return Err("composite instructions len".into());
                    }
                    let ilen = rd_u16(&out, pos).ok_or("instruction len")? as usize;
                    if pos + 2 + ilen > out.len() {
                        return Err("composite instructions truncated".into());
                    }
                }
                break;
            }
        }
        Ok(out)
    }

    fn build_cmap(&self, old_to_new: &HashMap<u16, u16>) -> Vec<u8> {
        let mut pairs: Vec<(u32, u32)> = self
            .cmap
            .iter()
            .filter_map(|(&cp, &old_gid)| old_to_new.get(&old_gid).map(|&new_gid| (cp, new_gid as u32)))
            .collect();
        pairs.sort_by_key(|&(cp, gid)| (cp, gid));
        pairs.dedup_by(|a, b| a.0 == b.0 && a.1 == b.1);

        let mut groups: Vec<(u32, u32, u32)> = Vec::new();
        for (cp, gid) in pairs {
            if let Some(last) = groups.last_mut() {
                let len = last.1 - last.0;
                let expected_gid = last.2 + len + 1;
                if cp == last.1 + 1 && gid == expected_gid {
                    last.1 = cp;
                    continue;
                }
            }
            groups.push((cp, cp, gid));
        }

        let subtable_len = 16 + groups.len() * 12;
        let mut fmt12 = Vec::with_capacity(subtable_len);
        push_u16(&mut fmt12, 12);
        push_u16(&mut fmt12, 0);
        push_u32(&mut fmt12, subtable_len as u32);
        push_u32(&mut fmt12, 0);
        push_u32(&mut fmt12, groups.len() as u32);
        for (start_cp, end_cp, start_gid) in groups {
            push_u32(&mut fmt12, start_cp);
            push_u32(&mut fmt12, end_cp);
            push_u32(&mut fmt12, start_gid);
        }

        let mut cmap = Vec::with_capacity(12 + fmt12.len());
        push_u16(&mut cmap, 0);
        push_u16(&mut cmap, 1);
        push_u16(&mut cmap, 3);
        push_u16(&mut cmap, 10);
        push_u32(&mut cmap, 12);
        cmap.extend_from_slice(&fmt12);
        cmap
    }

    fn build_post(&self) -> Option<Vec<u8>> {
        let post = self.table_bytes(b"post")?;
        if post.len() < 32 {
            return None;
        }
        let mut out = post[..32].to_vec();
        wr_u32(&mut out, 0, 0x0003_0000)?;
        Some(out)
    }

    fn build_font(&self, mut tables: Vec<([u8; 4], Vec<u8>)>) -> Result<Vec<u8>, String> {
        tables.sort_by_key(|(tag, _)| *tag);
        let num_tables = tables.len();
        let mut max_pow2 = 1usize;
        let mut entry_selector = 0u16;
        while max_pow2 * 2 <= num_tables {
            max_pow2 *= 2;
            entry_selector += 1;
        }
        let search_range = (max_pow2 * 16) as u16;
        let range_shift = (num_tables * 16) as u16 - search_range;

        let header_len = 12 + num_tables * 16;
        let mut offset = align4(header_len);
        let mut records: Vec<([u8; 4], u32, u32, u32)> = Vec::with_capacity(num_tables);
        for (tag, data) in tables.iter() {
            let checksum = table_checksum(data);
            let length = data.len() as u32;
            records.push((*tag, checksum, offset as u32, length));
            offset = align4(offset + data.len());
        }

        let sfnt_version = self.raw.get(0..4).ok_or("sfnt version")?;
        let mut out = vec![0u8; offset];
        out[0..4].copy_from_slice(sfnt_version);
        wr_u16(&mut out, 4, num_tables as u16).ok_or("numTables")?;
        wr_u16(&mut out, 6, search_range).ok_or("searchRange")?;
        wr_u16(&mut out, 8, entry_selector).ok_or("entrySelector")?;
        wr_u16(&mut out, 10, range_shift).ok_or("rangeShift")?;

        let mut rec_off = 12usize;
        for (tag, checksum, table_off, length) in records.iter() {
            out[rec_off..rec_off + 4].copy_from_slice(tag);
            wr_u32(&mut out, rec_off + 4, *checksum).ok_or("table checksum")?;
            wr_u32(&mut out, rec_off + 8, *table_off).ok_or("table offset")?;
            wr_u32(&mut out, rec_off + 12, *length).ok_or("table length")?;
            rec_off += 16;
        }

        for ((_, data), (_, _, table_off, _)) in tables.iter().zip(records.iter()) {
            let start = *table_off as usize;
            out[start..start + data.len()].copy_from_slice(data);
        }

        let head_rec = records
            .iter()
            .find(|(tag, _, _, _)| tag == b"head")
            .ok_or("no head record")?;
        let head_abs = head_rec.2 as usize;
        wr_u32(&mut out, head_abs + 8, 0).ok_or("clear checksumAdjustment")?;
        let sum = table_checksum(&out);
        let adj = 0xB1B0_AFBAu32.wrapping_sub(sum);
        wr_u32(&mut out, head_abs + 8, adj).ok_or("checksumAdjustment")?;
        Ok(out)
    }

    fn subset_bytes(&self, used_gids: &[u16]) -> Result<Vec<u8>, String> {
        let loca = self.loca_offsets()?;
        let mut keep = BTreeSet::new();
        keep.insert(0);
        for &gid in used_gids {
            self.collect_composite_glyphs(gid, &loca, &mut keep)?;
        }
        let keep: Vec<u16> = keep.into_iter().collect();
        let old_to_new: HashMap<u16, u16> = keep
            .iter()
            .enumerate()
            .map(|(new_gid, &old_gid)| (old_gid, new_gid as u16))
            .collect();

        let mut glyf = Vec::new();
        let mut loca_out = Vec::with_capacity((keep.len() + 1) * 4);
        for &old_gid in keep.iter() {
            push_u32(&mut loca_out, glyf.len() as u32);
            let glyph = self.glyph_bytes(&loca, old_gid)?;
            let rewritten = self.rewrite_glyph(glyph, &old_to_new)?;
            glyf.extend_from_slice(&rewritten);
            while glyf.len() % 4 != 0 {
                glyf.push(0);
            }
        }
        push_u32(&mut loca_out, glyf.len() as u32);

        let mut hmtx = Vec::with_capacity(keep.len() * 4);
        for &old_gid in keep.iter() {
            let g = old_gid as usize;
            let adv = *self.advance_units.get(g).unwrap_or(&0);
            let lsb = *self.left_side_bearings.get(g).unwrap_or(&0);
            push_u16(&mut hmtx, adv);
            push_i16(&mut hmtx, lsb);
        }

        let mut maxp = self.table_bytes(b"maxp").ok_or("no maxp")?.to_vec();
        if maxp.len() < 6 {
            return Err("maxp truncated".into());
        }
        wr_u16(&mut maxp, 4, keep.len() as u16).ok_or("maxp numGlyphs")?;

        let mut hhea = self.table_bytes(b"hhea").ok_or("no hhea")?.to_vec();
        if hhea.len() < 36 {
            return Err("hhea truncated".into());
        }
        wr_u16(&mut hhea, 34, keep.len() as u16).ok_or("hhea numHMetrics")?;

        let mut head = self.table_bytes(b"head").ok_or("no head")?.to_vec();
        if head.len() < 54 {
            return Err("head truncated".into());
        }
        wr_u32(&mut head, 8, 0).ok_or("head checksumAdjustment")?;
        wr_i16(&mut head, 50, 1).ok_or("head indexToLocFormat")?;

        let cmap = self.build_cmap(&old_to_new);

        let mut tables: Vec<([u8; 4], Vec<u8>)> = vec![
            (*b"cmap", cmap),
            (*b"glyf", glyf),
            (*b"head", head),
            (*b"hhea", hhea),
            (*b"hmtx", hmtx),
            (*b"loca", loca_out),
            (*b"maxp", maxp),
        ];

        for tag in [*b"OS/2", *b"name", *b"cvt ", *b"fpgm", *b"gasp", *b"prep"] {
            if let Some(bytes) = self.table_bytes(&tag) {
                tables.push((tag, bytes.to_vec()));
            }
        }
        if let Some(post) = self.build_post() {
            tables.push((*b"post", post));
        }

        self.build_font(tables)
    }

    /// Bytes to embed as FontFile2. Falls back to the original TTF on errors.
    pub fn embed_bytes(&self, used_gids: &[u16]) -> Vec<u8> {
        self.subset_bytes(used_gids)
            .unwrap_or_else(|_| self.raw.clone())
    }
}

fn parse_cmap(bytes: &[u8], &(off, _): &(usize, usize)) -> Result<HashMap<u32, u16>, String> {
    if off + 4 > bytes.len() {
        return Err("cmap header".into());
    }
    let num_tables = rd_u16(bytes, off + 2).ok_or("cmap numTables")? as usize;
    // Merge all usable Unicode subtables instead of picking only one "best"
    // record. Many fonts split coverage across subtables (e.g. BMP in format 4
    // plus astral/codepoint extensions in format 12). Choosing a single record
    // drops perfectly valid glyph mappings and later shows up as gid_for()==0 /
    // broken ToUnicode for characters the font actually contains.
    let mut subtables: Vec<(u32, usize)> = Vec::new(); // (priority, subtable offset)
    for i in 0..num_tables {
        let rec = off + 4 + i * 8;
        if rec + 8 > bytes.len() {
            break;
        }
        let platform = rd_u16(bytes, rec).unwrap_or(0);
        let encoding = rd_u16(bytes, rec + 2).unwrap_or(0);
        let sub_off = rd_u32(bytes, rec + 4).unwrap_or(0) as usize;
        let prio = match (platform, encoding) {
            (3, 10) => 100,
            (0, _) => 80,
            (3, 1) => 60,
            (3, 0) => 40,
            _ => 0,
        };
        if prio > 0 {
            subtables.push((prio, off + sub_off));
        }
    }
    if subtables.is_empty() {
        return Err("no usable cmap subtable".into());
    }
    subtables.sort_by_key(|&(prio, sub_off)| (prio, sub_off));

    let mut merged = HashMap::new();
    let mut parsed_any = false;
    for (_, sub_off) in subtables {
        if sub_off + 2 > bytes.len() {
            continue;
        }
        let format = rd_u16(bytes, sub_off).unwrap_or(0);
        let parsed = match format {
            0 => parse_cmap_fmt0(bytes, sub_off),
            4 => parse_cmap_fmt4(bytes, sub_off),
            6 => parse_cmap_fmt6(bytes, sub_off),
            12 => parse_cmap_fmt12(bytes, sub_off),
            _ => continue,
        };
        if let Ok(map) = parsed {
            parsed_any = true;
            for (cp, gid) in map {
                merged.insert(cp, gid);
            }
        }
    }
    if !parsed_any || merged.is_empty() {
        return Err("no supported cmap format".into());
    }
    Ok(merged)
}

fn parse_cmap_fmt0(bytes: &[u8], off: usize) -> Result<HashMap<u32, u16>, String> {
    let mut m = HashMap::new();
    let base = off + 6;
    if base + 256 > bytes.len() {
        return Err("cmap fmt0 len".into());
    }
    for cp in 0..256u32 {
        let gid = bytes[base + cp as usize] as u16;
        if gid != 0 {
            m.insert(cp, gid);
        }
    }
    Ok(m)
}

fn parse_cmap_fmt6(bytes: &[u8], off: usize) -> Result<HashMap<u32, u16>, String> {
    let first = rd_u16(bytes, off + 6).ok_or("fmt6 first")? as u32;
    let count = rd_u16(bytes, off + 8).ok_or("fmt6 count")? as usize;
    let base = off + 10;
    if base + count * 2 > bytes.len() {
        return Err("cmap fmt6 len".into());
    }
    let mut m = HashMap::new();
    for i in 0..count {
        let gid = rd_u16(bytes, base + i * 2).unwrap_or(0);
        if gid != 0 {
            m.insert(first + i as u32, gid);
        }
    }
    Ok(m)
}

fn parse_cmap_fmt4(bytes: &[u8], off: usize) -> Result<HashMap<u32, u16>, String> {
    // segCountX2 at off+6
    let seg_count_x2 = rd_u16(bytes, off + 6).ok_or("fmt4 segCount")? as usize;
    let seg_count = seg_count_x2 / 2;
    let end_base = off + 14;
    let start_base = end_base + seg_count_x2 + 2; // +2 for reservedPad
    let delta_base = start_base + seg_count_x2;
    let range_base = delta_base + seg_count_x2;
    let mut m = HashMap::new();
    for i in 0..seg_count {
        let end = rd_u16(bytes, end_base + i * 2).unwrap_or(0);
        let start = rd_u16(bytes, start_base + i * 2).unwrap_or(0);
        let delta = rd_i16(bytes, delta_base + i * 2).unwrap_or(0) as i32;
        let range = rd_u16(bytes, range_base + i * 2).unwrap_or(0) as u32;
        if start == 0xFFFF && end == 0xFFFF {
            continue;
        }
        let mut c = start as u32;
        while c <= end as u32 {
            let gid = if range != 0 {
                let idx = c - start as u32;
                let id_range_off_addr = range_base + i * 2;
                let gid_off = id_range_off_addr + range as usize + (idx as usize) * 2;
                let raw_gid = rd_u16(bytes, gid_off).unwrap_or(0);
                if raw_gid == 0 {
                    0
                } else {
                    (raw_gid as i32 + delta) & 0xFFFF
                }
            } else {
                (c as i32 + delta) & 0xFFFF
            };
            if gid != 0 {
                m.insert(c, gid as u16);
            }
            c += 1;
        }
    }
    Ok(m)
}

fn parse_cmap_fmt12(bytes: &[u8], off: usize) -> Result<HashMap<u32, u16>, String> {
    let num_groups = rd_u32(bytes, off + 12).ok_or("fmt12 groups")? as usize;
    let base = off + 16;
    if base + num_groups * 12 > bytes.len() {
        return Err("cmap fmt12 len".into());
    }
    let mut m = HashMap::new();
    for i in 0..num_groups {
        let g = base + i * 12;
        let start_cp = rd_u32(bytes, g).unwrap_or(0);
        let end_cp = rd_u32(bytes, g + 4).unwrap_or(0);
        let start_gid = rd_u32(bytes, g + 8).unwrap_or(0);
        for cp in start_cp..=end_cp {
            let gid = start_gid + (cp - start_cp);
            if gid != 0 && gid < 0x10000 {
                m.insert(cp, gid as u16);
            }
        }
    }
    Ok(m)
}

#[cfg(test)]
mod tests {
    use super::TtfFont;
    use std::fs;
    use std::path::PathBuf;

    fn load_source_han() -> TtfFont {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("examples")
            .join("SourceHanSansSC-Regular.ttf");
        let bytes = fs::read(path).expect("read SourceHanSansSC-Regular.ttf");
        TtfFont::parse(&bytes).expect("parse SourceHanSansSC-Regular.ttf")
    }

    #[test]
    fn source_han_covers_reported_missing_codepoints() {
        let ttf = load_source_han();
        for cp in [
            0x544A, 0x9C7C, 0x8C28, 0x614E, 0x4EFF, 0x96F7, 0x660E, 0x54A6, 0x597D, 0x5FEB,
            0x5427,
        ] {
            assert_ne!(ttf.gid_for(cp), 0, "expected glyph for U+{:04X}", cp);
        }
    }

    #[test]
    fn source_han_covers_basic_latin_demo_text() {
        let ttf = load_source_han();
        for ch in "Single HTML DemoBundle ShapeRender Core".chars() {
            if ch == ' ' {
                continue;
            }
            assert_ne!(ttf.gid_for(ch as u32), 0, "expected glyph for {:?}", ch);
        }
    }
}
