//! Binary Snapshot parser.
//!
//! Contract (all integers little-endian, floats = f32 LE):
//!
//! Header:
//!   magic: 4 bytes = "D2P1"
//!   version: u32 = 15
//!   pageWidthPt, pageHeightPt, marginTop, marginRight, marginBottom, marginLeft: f32
//!
//! Config block:
//!   precision: u8            (decimal places for coordinate formatting)
//!   pagination: u8           (0 = single page, 1 = paginated)
//!   hasBackground: u8
//!   if hasBackground: bgR,bgG,bgB,bgA f32
//!   headerHPx: f32           (reserved header band height, CSS px)
//!   footerHPx: f32           (reserved footer band height, CSS px)
//!   hasStaticHF: u8          (1 = object-form pageConfig, Rust resolves placeholders)
//!   if hasStaticHF:
//!     header: Option<HFSpec> (u8 present + fields; v14 = multi-slot region)
//!     footer: Option<HFSpec>
//!   compress: u8             (v8+: 0 = no compression, 1 = deflate streams)
//!   staticWatermark: Option<WatermarkSpec> (v9+; image variant added in v10)
//!
//! Fonts block:
//!   fontCount: u32
//!   fonts[fontCount]: familyLen u16 + utf8 ; style u8 ; weight u16 ; iconFont u8 ;
//!                     byteLen u32 + bytes (ttf)
//!
//! Per-page HF block (function-form pageConfig, resolved text; empty for object form):
//!   perPageCount: u32
//!   perPage[perPageCount]: headerPresent u8 ; if present HFSpec ;
//!                          footerPresent u8 ; if present HFSpec
//!
//! Per-page watermark block (function-form watermark or excludePages):
//!   perPageWatermarkCount: u32
//!   perPageWatermarks[perPageWatermarkCount]: present u8 ; if present WatermarkSpec
//!
//! Nodes:
//!   nodeCount: u32
//!   nodes[nodeCount]: each ->
//!     id: u32, parent: i32, kind: u8 (0 box,1 text,2 image)
//!     x,y,w,h: f32 (CSS px, document space, top-left origin)
//!     flags: u16 (b0 hasBg, b1 hasBorder, b2 hasRadius, b3 overflowHidden,
//!                 b4 hasOpacity, b5 hasFont, b6 hasImage, b7 hasRenderMode,
//!                 b8 divisionDisable, b9 pageBreak)
//!     if hasBg: r,g,b,a f32
//!     if hasBorder: bwTop,bwRight,bwBottom,bwLeft f32 ; br,bg,bb,ba f32 ;
//!                   styleTop,styleRight,styleBottom,styleLeft u8
//!     if hasRadius: tl,tr,br,bl f32
//!     if hasOpacity: opacity f32
//!     if hasFont: familyLen u16 + utf8 ; sizePx f32 ; weight u16 ; italic u8 ;
//!                 cr,cg,cb,ca f32 ; lineHeightPx f32 ; align u8 ;
//!                 letterSpacingPx f32 ; wordSpacingPx f32 ; preserveWhitespace u8 ;
//!                 decorationLineMask u8 ; decorationThicknessPx f32   (v15+)
//!     if hasImage: imageId u32 ; objectFit u8 ;
//!                  objectPositionXPct f32 ; objectPositionXOffsetPx f32 ;
//!                  objectPositionYPct f32 ; objectPositionYOffsetPx f32
//!     if hasRenderMode: renderMode u8
//!     if kind==text: textLen u32 + utf8 ; lineCount u32 ;
//!                    lines: lineCount x (x,y,w,h f32 ; start u32 ; end u32)
//!
//! Form fields (v11+):
//!   formFieldCount: u32
//!   formFields[formFieldCount]: each ->
//!     id: u32, nodeId: u32, kind: u8, interactiveKind: u8, textAlign: u8,
//!     flags: u16,
//!     paddingTop/right/bottom/left: f32,
//!     name/value/defaultValue/placeholder: u32 len + utf8,
//!     optionCount: u32,
//!     options[optionCount]: label u32+utf8 ; value u32+utf8 ; selected u8
//!
//! Images (imageCount): each ->
//!   id u32 ; width u32 ; height u32 ; format u8 ; byteLen u32 ; bytes[byteLen]
//!   format: 0 = JPEG (DCTDecode), 1 = raw RGB888 (FlateDecode, lossless),
//!           2 = raw RGBA8888 (FlateDecode + SMask)

pub struct Snapshot {
    pub page_width_pt: f32,
    pub page_height_pt: f32,
    pub margin_top: f32,
    pub margin_right: f32,
    pub margin_bottom: f32,
    pub margin_left: f32,
    pub config: Config,
    pub fonts: Vec<FontResource>,
    pub per_page_hf: Vec<PageHF>,
    pub per_page_watermark: Vec<Option<WatermarkSpec>>,
    pub nodes: Vec<Node>,
    pub form_fields: Vec<FormField>,
    pub images: Vec<Image>,
}

pub struct Config {
    pub precision: u8,
    // Encoded by JS encoder; Rust uses `single_page` instead. Kept to mirror
    // the wire format.
    #[allow(dead_code)]
    pub pagination: u8,
    pub single_page: bool,
    pub background: Option<[f32; 4]>,
    pub header_h_px: f32,
    pub footer_h_px: f32,
    pub static_hf: Option<(Option<HFSpec>, Option<HFSpec>)>,
    /// v8: enable real DEFLATE compression for PDF streams.
    pub compress: bool,
    pub static_watermark: Option<WatermarkSpec>,
}

#[derive(Clone)]
pub struct FontResource {
    pub family: String,
    pub style: u8, // 0 normal, 1 italic
    pub weight: u16,
    // Encoded by JS encoder; not consumed by the Rust side yet.
    #[allow(dead_code)]
    pub icon_font: bool,
    pub bytes: Vec<u8>,
}

/// Header/footer custom slot position relative to the region inner box.
#[derive(Clone)]
pub struct HFSlotCustomPosition {
    pub x_pct: f32,
    pub x_offset_px: f32,
    pub y_pct: f32,
    pub y_offset_px: f32,
    pub anchor: u8,
}

/// Header/footer slot spec.
#[derive(Clone)]
pub struct HFSlotSpec {
    pub content: String,
    pub color: [f32; 4],
    pub family: String,
    pub font_size_px: f32,
    pub weight: u16,
    pub italic: u8,
    pub position: u8, // 0..8 semantic, 9 legacy custom [x,y], 10 custom inner-box position
    pub custom: Option<(f32, f32)>,
    pub custom_position: Option<HFSlotCustomPosition>,
}

/// Header/footer spec for one region (header or footer).
#[derive(Clone)]
pub struct HFSpec {
    pub height_px: f32,
    pub padding: [f32; 4], // top,right,bottom,left px
    pub slots: Vec<HFSlotSpec>,
}

#[derive(Clone)]
pub struct WatermarkSpec {
    pub kind: u8, // 0 text, 1 image
    pub text: String,
    pub color: [f32; 4],
    pub family: String,
    pub font_size_px: f32,
    pub weight: u16,
    pub italic: u8,
    pub image_id: u32,
    pub image_width_px: f32,
    pub image_height_px: f32,
    pub opacity: f32,
    pub angle_deg: f32,
    pub spacing: [f32; 2],
    pub offset: [f32; 2],
    pub layer: u8, // 0 under, 1 over
}

#[derive(Clone, Default)]
pub struct PageHF {
    pub header: Option<HFSpec>,
    pub footer: Option<HFSpec>,
}

pub struct Node {
    pub id: u32,
    pub parent: i32,
    pub kind: u8,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub flags: u16,
    pub bg: Option<[f32; 4]>,
    pub border: Option<Border>,
    pub shadow: Vec<BoxShadow>,
    pub radius: Option<[f32; 4]>,
    pub overflow_hidden: bool,
    pub opacity: Option<f32>,
    pub font: Option<Font>,
    pub image: Option<ImageRef>,
    pub render_mode: u8,
    pub division_disable: bool,
    pub page_break: bool,
    pub href: Option<String>,
    pub text: Option<String>,
    pub lines: Vec<Line>,
}

// flag bits (must match JS encoder)
pub const F_BG: u16 = 0x01;
pub const F_BORDER: u16 = 0x02;
pub const F_RADIUS: u16 = 0x04;
pub const F_OVERFLOW: u16 = 0x08;
pub const F_OPACITY: u16 = 0x10;
pub const F_FONT: u16 = 0x20;
pub const F_IMAGE: u16 = 0x40;
pub const F_RENDER_MODE: u16 = 0x80;
pub const F_DIVISION_DISABLE: u16 = 0x100;
pub const F_PAGE_BREAK: u16 = 0x200;
pub const F_SHADOW: u16 = 0x400;
pub const F_LINK: u16 = 0x800;
pub const F_AVOID_IMAGE_SPLIT: u16 = 0x1000;

#[derive(Clone)]
pub struct Border {
    pub w: [f32; 4],      // top,right,bottom,left px
    pub c: [[f32; 4]; 4], // per-side rgba: top,right,bottom,left
    pub s: [u8; 4],       // 0 solid, 1 dashed
}

#[derive(Clone)]
pub struct BoxShadow {
    pub x: f32,
    pub y: f32,
    pub blur: f32,
    pub spread: f32,
    pub color: [f32; 4],
}

#[derive(Clone)]
pub struct Font {
    pub family: String,
    pub size_px: f32,
    pub weight: u16,
    pub italic: u8,
    pub color: [f32; 4],
    // Encoded by JS encoder; not consumed by the Rust side yet.
    #[allow(dead_code)]
    pub line_height_px: f32,
    pub align: u8, // 0 left,1 right,2 center,3 justify
    pub letter_spacing_px: f32,
    pub word_spacing_px: f32,
    pub preserve_whitespace: bool,
    pub decoration_line_mask: u8, // bit 0 underline, 1 line-through, 2 overline
    pub decoration_thickness_px: f32,
}

#[derive(Clone)]
pub struct ImageRef {
    pub id: u32,
    pub object_fit: u8,
    pub object_position_x_pct: f32,
    pub object_position_x_offset_px: f32,
    pub object_position_y_pct: f32,
    pub object_position_y_offset_px: f32,
}

#[derive(Clone, Copy)]
pub struct Line {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub start: u32,
    pub end: u32,
    pub page: u32,
    pub draw_y: f32, // document y to use when drawing (may be adjusted for pagination)
}

pub struct Image {
    pub id: u32,
    pub width: u32,
    pub height: u32,
    /// 0 = JPEG bytes (embed as /DCTDecode), 1 = raw RGB888 (lossless,
    /// embed as /FlateDecode), 2 = raw RGBA8888 (lossless, split into RGB +
    /// soft-mask image objects).
    pub format: u8,
    pub bytes: Vec<u8>,
}

#[derive(Clone)]
pub struct FormFieldOption {
    pub label: String,
    pub value: String,
    pub selected: bool,
}

#[derive(Clone)]
pub struct FormField {
    pub id: u32,
    pub node_id: u32,
    pub kind: u8,
    pub interactive_kind: u8,
    pub text_align: u8,
    pub checked: bool,
    pub disabled: bool,
    pub readonly: bool,
    pub required: bool,
    pub multiple: bool,
    pub placeholder_shown: bool,
    pub password: bool,
    pub name: String,
    pub value: String,
    pub default_value: String,
    pub placeholder: String,
    pub padding: [f32; 4],
    pub options: Vec<FormFieldOption>,
}

pub const FORM_FLAG_CHECKED: u16 = 0x01;
pub const FORM_FLAG_DISABLED: u16 = 0x02;
pub const FORM_FLAG_READONLY: u16 = 0x04;
pub const FORM_FLAG_REQUIRED: u16 = 0x08;
pub const FORM_FLAG_MULTIPLE: u16 = 0x10;
pub const FORM_FLAG_PLACEHOLDER_SHOWN: u16 = 0x20;
pub const FORM_FLAG_PASSWORD: u16 = 0x40;

struct Cursor<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }
    fn need(&self, n: usize) -> Result<(), String> {
        if self.pos + n > self.data.len() {
            Err(format!(
                "snapshot truncated at {} need {} have {}",
                self.pos,
                n,
                self.data.len()
            ))
        } else {
            Ok(())
        }
    }
    fn u8(&mut self) -> Result<u8, String> {
        self.need(1)?;
        let v = self.data[self.pos];
        self.pos += 1;
        Ok(v)
    }
    fn u16(&mut self) -> Result<u16, String> {
        self.need(2)?;
        let v = u16::from_le_bytes([self.data[self.pos], self.data[self.pos + 1]]);
        self.pos += 2;
        Ok(v)
    }
    fn u32(&mut self) -> Result<u32, String> {
        self.need(4)?;
        let v = u32::from_le_bytes([
            self.data[self.pos],
            self.data[self.pos + 1],
            self.data[self.pos + 2],
            self.data[self.pos + 3],
        ]);
        self.pos += 4;
        Ok(v)
    }
    fn i32(&mut self) -> Result<i32, String> {
        Ok(self.u32()? as i32)
    }
    fn f32(&mut self) -> Result<f32, String> {
        self.need(4)?;
        let v = f32::from_le_bytes([
            self.data[self.pos],
            self.data[self.pos + 1],
            self.data[self.pos + 2],
            self.data[self.pos + 3],
        ]);
        self.pos += 4;
        Ok(v)
    }
    fn bytes(&mut self, n: usize) -> Result<&'a [u8], String> {
        self.need(n)?;
        let v = &self.data[self.pos..self.pos + n];
        self.pos += n;
        Ok(v)
    }
    fn utf8(&mut self, n: usize) -> Result<String, String> {
        let b = self.bytes(n)?;
        std::str::from_utf8(b)
            .map(|s| s.to_string())
            .map_err(|e| format!("utf8 error: {}", e))
    }
}

fn parse_hf_v13(c: &mut Cursor) -> Result<HFSpec, String> {
    let clen = c.u16()? as usize;
    let content = c.utf8(clen)?;
    let height_px = c.f32()?;
    let cr = c.f32()?;
    let cg = c.f32()?;
    let cb = c.f32()?;
    let ca = c.f32()?;
    let font_size_px = c.f32()?;
    let position = c.u8()?;
    let custom = if position == 9 {
        Some((c.f32()?, c.f32()?))
    } else {
        None
    };
    let p0 = c.f32()?;
    let p1 = c.f32()?;
    let p2 = c.f32()?;
    let p3 = c.f32()?;
    Ok(HFSpec {
        height_px,
        padding: [p0, p1, p2, p3],
        slots: vec![HFSlotSpec {
            content,
            color: [cr, cg, cb, ca],
            family: "Helvetica".to_string(),
            font_size_px,
            weight: 400,
            italic: 0,
            position,
            custom,
            custom_position: None,
        }],
    })
}

fn parse_hf(c: &mut Cursor) -> Result<HFSpec, String> {
    let height_px = c.f32()?;
    let p0 = c.f32()?;
    let p1 = c.f32()?;
    let p2 = c.f32()?;
    let p3 = c.f32()?;
    let slot_count = c.u16()? as usize;
    let mut slots = Vec::with_capacity(slot_count);
    for _ in 0..slot_count {
        let clen = c.u16()? as usize;
        let content = c.utf8(clen)?;
        let color = [c.f32()?, c.f32()?, c.f32()?, c.f32()?];
        let flen = c.u16()? as usize;
        let family = c.utf8(flen)?;
        let font_size_px = c.f32()?;
        let weight = c.u16()?;
        let italic = c.u8()?;
        let position = c.u8()?;
        let custom = if position == 9 {
            Some((c.f32()?, c.f32()?))
        } else {
            None
        };
        let custom_position = if position == 10 {
            Some(HFSlotCustomPosition {
                x_pct: c.f32()?,
                x_offset_px: c.f32()?,
                y_pct: c.f32()?,
                y_offset_px: c.f32()?,
                anchor: c.u8()?,
            })
        } else {
            None
        };
        slots.push(HFSlotSpec {
            content,
            color,
            family,
            font_size_px,
            weight,
            italic,
            position,
            custom,
            custom_position,
        });
    }
    Ok(HFSpec {
        height_px,
        padding: [p0, p1, p2, p3],
        slots,
    })
}

fn parse_opt_hf(c: &mut Cursor, version: u32) -> Result<Option<HFSpec>, String> {
    Ok(if c.u8()? != 0 {
        Some(if version >= 14 { parse_hf(c)? } else { parse_hf_v13(c)? })
    } else {
        None
    })
}

fn parse_watermark_v9(c: &mut Cursor) -> Result<WatermarkSpec, String> {
    let tlen = c.u16()? as usize;
    let text = c.utf8(tlen)?;
    let color = [c.f32()?, c.f32()?, c.f32()?, c.f32()?];
    let flen = c.u16()? as usize;
    let family = c.utf8(flen)?;
    let font_size_px = c.f32()?;
    let weight = c.u16()?;
    let italic = c.u8()?;
    let angle_deg = c.f32()?;
    let spacing = [c.f32()?, c.f32()?];
    let offset = [c.f32()?, c.f32()?];
    let layer = c.u8()?;
    Ok(WatermarkSpec {
        kind: 0,
        text,
        color,
        family,
        font_size_px,
        weight,
        italic,
        image_id: 0,
        image_width_px: 0.0,
        image_height_px: 0.0,
        opacity: color[3],
        angle_deg,
        spacing,
        offset,
        layer,
    })
}

fn parse_watermark(c: &mut Cursor, version: u32) -> Result<WatermarkSpec, String> {
    if version < 10 {
        return parse_watermark_v9(c);
    }
    let kind = c.u8()?;
    let angle_deg = c.f32()?;
    let spacing = [c.f32()?, c.f32()?];
    let offset = [c.f32()?, c.f32()?];
    let layer = c.u8()?;
    match kind {
        0 => {
            let tlen = c.u16()? as usize;
            let text = c.utf8(tlen)?;
            let color = [c.f32()?, c.f32()?, c.f32()?, c.f32()?];
            let flen = c.u16()? as usize;
            let family = c.utf8(flen)?;
            let font_size_px = c.f32()?;
            let weight = c.u16()?;
            let italic = c.u8()?;
            Ok(WatermarkSpec {
                kind,
                text,
                color,
                family,
                font_size_px,
                weight,
                italic,
                image_id: 0,
                image_width_px: 0.0,
                image_height_px: 0.0,
                opacity: color[3],
                angle_deg,
                spacing,
                offset,
                layer,
            })
        }
        1 => Ok(WatermarkSpec {
            kind,
            text: String::new(),
            color: [0.0, 0.0, 0.0, 0.0],
            family: String::new(),
            font_size_px: 0.0,
            weight: 400,
            italic: 0,
            image_id: c.u32()?,
            image_width_px: c.f32()?,
            image_height_px: c.f32()?,
            opacity: c.f32()?,
            angle_deg,
            spacing,
            offset,
            layer,
        }),
        _ => Err(format!("unsupported watermark kind {}", kind)),
    }
}

fn parse_opt_watermark(c: &mut Cursor, version: u32) -> Result<Option<WatermarkSpec>, String> {
    Ok(if c.u8()? != 0 {
        Some(parse_watermark(c, version)?)
    } else {
        None
    })
}

fn parse_string32(c: &mut Cursor) -> Result<String, String> {
    let len = c.u32()? as usize;
    c.utf8(len)
}

fn parse_form_field(c: &mut Cursor) -> Result<FormField, String> {
    let id = c.u32()?;
    let node_id = c.u32()?;
    let kind = c.u8()?;
    let interactive_kind = c.u8()?;
    let text_align = c.u8()?;
    let flags = c.u16()?;
    let padding = [c.f32()?, c.f32()?, c.f32()?, c.f32()?];
    let name = parse_string32(c)?;
    let value = parse_string32(c)?;
    let default_value = parse_string32(c)?;
    let placeholder = parse_string32(c)?;
    let option_count = c.u32()?;
    let mut options = Vec::with_capacity(option_count as usize);
    for _ in 0..option_count {
        options.push(FormFieldOption {
            label: parse_string32(c)?,
            value: parse_string32(c)?,
            selected: c.u8()? != 0,
        });
    }
    Ok(FormField {
        id,
        node_id,
        kind,
        interactive_kind,
        text_align,
        checked: flags & FORM_FLAG_CHECKED != 0,
        disabled: flags & FORM_FLAG_DISABLED != 0,
        readonly: flags & FORM_FLAG_READONLY != 0,
        required: flags & FORM_FLAG_REQUIRED != 0,
        multiple: flags & FORM_FLAG_MULTIPLE != 0,
        placeholder_shown: flags & FORM_FLAG_PLACEHOLDER_SHOWN != 0,
        password: flags & FORM_FLAG_PASSWORD != 0,
        name,
        value,
        default_value,
        placeholder,
        padding,
        options,
    })
}

pub fn parse(data: &[u8]) -> Result<Snapshot, String> {
    let mut c = Cursor::new(data);
    let magic = c.bytes(4)?;
    if magic != b"D2P1" {
        return Err(format!("bad magic: {:?}", magic));
    }
    let version = c.u32()?;
    if version != 7 && version != 8 && version != 9 && version != 10 && version != 11 && version != 12 && version != 13 && version != 14 && version != 15 {
        return Err(format!(
            "unsupported version {} (expected 7, 8, 9, 10, 11, 12, 13, 14 or 15)",
            version
        ));
    }
    let page_width_pt = c.f32()?;
    let page_height_pt = c.f32()?;
    let margin_top = c.f32()?;
    let margin_right = c.f32()?;
    let margin_bottom = c.f32()?;
    let margin_left = c.f32()?;

    // Config block
    let precision = c.u8()?;
    let pagination = c.u8()?;
    let single_page = pagination == 0;
    let has_bg = c.u8()?;
    let background = if has_bg != 0 {
        Some([c.f32()?, c.f32()?, c.f32()?, c.f32()?])
    } else {
        None
    };
    let header_h_px = c.f32()?;
    let footer_h_px = c.f32()?;
    let has_static_hf = c.u8()?;
    let static_hf = if has_static_hf != 0 {
        let header = parse_opt_hf(&mut c, version)?;
        let footer = parse_opt_hf(&mut c, version)?;
        Some((header, footer))
    } else {
        None
    };
    // v8: compress flag. v7 has no such field; default to false.
    let compress = if version >= 8 { c.u8()? != 0 } else { false };
    let static_watermark = if version >= 9 {
        parse_opt_watermark(&mut c, version)?
    } else {
        None
    };

    // Fonts block
    let font_count = c.u32()?;
    let mut fonts = Vec::with_capacity(font_count as usize);
    for _ in 0..font_count {
        let flen = c.u16()? as usize;
        let family = c.utf8(flen)?;
        let style = c.u8()?;
        let weight = c.u16()?;
        let icon_font = c.u8()? != 0;
        let blen = c.u32()? as usize;
        let bytes = c.bytes(blen)?.to_vec();
        fonts.push(FontResource {
            family,
            style,
            weight,
            icon_font,
            bytes,
        });
    }

    // Per-page HF block
    let per_page_count = c.u32()?;
    let mut per_page_hf = Vec::with_capacity(per_page_count as usize);
    for _ in 0..per_page_count {
        let header = parse_opt_hf(&mut c, version)?;
        let footer = parse_opt_hf(&mut c, version)?;
        per_page_hf.push(PageHF { header, footer });
    }
    let per_page_watermark = if version >= 9 {
        let count = c.u32()?;
        let mut out = Vec::with_capacity(count as usize);
        for _ in 0..count {
            out.push(parse_opt_watermark(&mut c, version)?);
        }
        out
    } else {
        Vec::new()
    };

    let config = Config {
        precision,
        pagination,
        single_page,
        background,
        header_h_px,
        footer_h_px,
        static_hf,
        compress,
        static_watermark,
    };

    // Nodes
    let node_count = c.u32()?;
    let mut nodes = Vec::with_capacity(node_count as usize);
    for _ in 0..node_count {
        let id = c.u32()?;
        let parent = c.i32()?;
        let kind = c.u8()?;
        let x = c.f32()?;
        let y = c.f32()?;
        let w = c.f32()?;
        let h = c.f32()?;
        let flags = c.u16()?;
        let bg = if flags & F_BG != 0 {
            Some([c.f32()?, c.f32()?, c.f32()?, c.f32()?])
        } else {
            None
        };
        let border = if flags & F_BORDER != 0 {
            let bw = [c.f32()?, c.f32()?, c.f32()?, c.f32()?];
            let bc = [
                [c.f32()?, c.f32()?, c.f32()?, c.f32()?],
                [c.f32()?, c.f32()?, c.f32()?, c.f32()?],
                [c.f32()?, c.f32()?, c.f32()?, c.f32()?],
                [c.f32()?, c.f32()?, c.f32()?, c.f32()?],
            ];
            let bs = [c.u8()?, c.u8()?, c.u8()?, c.u8()?];
            Some(Border {
                w: bw,
                c: bc,
                s: bs,
            })
        } else {
            None
        };
        let shadow = if flags & F_SHADOW != 0 {
            let count = c.u8()? as usize;
            let mut layers = Vec::with_capacity(count);
            for _ in 0..count {
                layers.push(BoxShadow {
                    x: c.f32()?,
                    y: c.f32()?,
                    blur: c.f32()?,
                    spread: c.f32()?,
                    color: [c.f32()?, c.f32()?, c.f32()?, c.f32()?],
                });
            }
            layers
        } else {
            Vec::new()
        };
        let radius = if flags & F_RADIUS != 0 {
            Some([c.f32()?, c.f32()?, c.f32()?, c.f32()?])
        } else {
            None
        };
        let overflow_hidden = flags & F_OVERFLOW != 0;
        let opacity = if flags & F_OPACITY != 0 {
            Some(c.f32()?)
        } else {
            None
        };
        let font = if flags & F_FONT != 0 {
            let flen = c.u16()? as usize;
            let family = c.utf8(flen)?;
            let size_px = c.f32()?;
            let weight = c.u16()?;
            let italic = c.u8()?;
            let color = [c.f32()?, c.f32()?, c.f32()?, c.f32()?];
            let line_height_px = c.f32()?;
            let align = c.u8()?;
            let letter_spacing_px = c.f32()?;
            let word_spacing_px = c.f32()?;
            let preserve_whitespace = c.u8()? != 0;
            let decoration_line_mask = if version >= 15 { c.u8()? } else { 0 };
            let decoration_thickness_px = if version >= 15 { c.f32()? } else { 0.0 };
            Some(Font {
                family,
                size_px,
                weight,
                italic,
                color,
                line_height_px,
                align,
                letter_spacing_px,
                word_spacing_px,
                preserve_whitespace,
                decoration_line_mask,
                decoration_thickness_px,
            })
        } else {
            None
        };
        let image = if flags & F_IMAGE != 0 {
            let image_id = c.u32()?;
            let object_fit = c.u8()?;
            Some(ImageRef {
                id: image_id,
                object_fit,
                object_position_x_pct: if version >= 13 { c.f32()? } else { 0.5 },
                object_position_x_offset_px: if version >= 13 { c.f32()? } else { 0.0 },
                object_position_y_pct: if version >= 13 { c.f32()? } else { 0.5 },
                object_position_y_offset_px: if version >= 13 { c.f32()? } else { 0.0 },
            })
        } else {
            None
        };
        let render_mode = if flags & F_RENDER_MODE != 0 { c.u8()? } else { 0 };
        let division_disable = flags & F_DIVISION_DISABLE != 0;
        let page_break = flags & F_PAGE_BREAK != 0;
        let href = if version >= 11 && flags & F_LINK != 0 {
            let href_len = c.u32()? as usize;
            Some(c.utf8(href_len)?)
        } else {
            None
        };
        let mut text = None;
        let mut lines = Vec::new();
        if kind == 1 {
            let tlen = c.u32()? as usize;
            text = Some(c.utf8(tlen)?);
            let line_count = c.u32()?;
            for _ in 0..line_count {
                let lx = c.f32()?;
                let ly = c.f32()?;
                let lw = c.f32()?;
                let lh = c.f32()?;
                let start = c.u32()?;
                let end = c.u32()?;
                lines.push(Line {
                    x: lx,
                    y: ly,
                    w: lw,
                    h: lh,
                    start,
                    end,
                    page: 0,
                    draw_y: ly,
                });
            }
        }
        nodes.push(Node {
            id,
            parent,
            kind,
            x,
            y,
            w,
            h,
            flags,
            bg,
            border,
            shadow,
            radius,
            overflow_hidden,
            opacity,
            font,
            image,
            render_mode,
            division_disable,
            page_break,
            href,
            text,
            lines,
        });
    }

    let form_fields = if version >= 11 {
        let count = c.u32()?;
        let mut out = Vec::with_capacity(count as usize);
        for _ in 0..count {
            out.push(parse_form_field(&mut c)?);
        }
        out
    } else {
        Vec::new()
    };

    let image_count = c.u32()?;
    let mut images = Vec::with_capacity(image_count as usize);
    for _ in 0..image_count {
        let id = c.u32()?;
        let width = c.u32()?;
        let height = c.u32()?;
        let format = c.u8()?;
        let byte_len = c.u32()? as usize;
        let bytes = c.bytes(byte_len)?.to_vec();
        images.push(Image {
            id,
            width,
            height,
            format,
            bytes,
        });
    }

    Ok(Snapshot {
        page_width_pt,
        page_height_pt,
        margin_top,
        margin_right,
        margin_bottom,
        margin_left,
        config,
        fonts,
        per_page_hf,
        per_page_watermark,
        nodes,
        form_fields,
        images,
    })
}
