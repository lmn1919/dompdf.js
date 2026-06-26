//! Binary Snapshot v3 parser.
//!
//! Contract (all integers little-endian, floats = f32 LE):
//!
//! Header:
//!   magic: 4 bytes = "D2P1"
//!   version: u32 = 5
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
//!     header: Option<HFSpec> (u8 present + fields)
//!     footer: Option<HFSpec>
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
//!                 letterSpacingPx f32 ; wordSpacingPx f32
//!     if hasImage: imageId u32 ; objectFit u8
//!     if hasRenderMode: renderMode u8
//!     if kind==text: textLen u32 + utf8 ; lineCount u32 ;
//!                    lines: lineCount x (x,y,w,h f32 ; start u32 ; end u32)
//!
//! Images (imageCount): each ->
//!   id u32 ; width u32 ; height u32 ; format u8 ; byteLen u32 ; bytes[byteLen]
//!   format: 0 = JPEG (DCTDecode), 1 = raw RGB888 (FlateDecode, lossless)

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
    pub nodes: Vec<Node>,
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

/// Header/footer spec for one region (header or footer).
#[derive(Clone)]
pub struct HFSpec {
    pub content: String,
    pub height_px: f32,
    pub color: [f32; 4],
    pub font_size_px: f32,
    pub position: u8, // 0 center,1 centerLeft,2 centerRight,3 centerTop,4 centerBottom,
    // 5 leftTop,6 leftBottom,7 rightTop,8 rightBottom,9 custom
    pub custom: Option<(f32, f32)>, // px, when position==9
    pub padding: [f32; 4],          // top,right,bottom,left px
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
    pub shadow: Option<BoxShadow>,
    pub radius: Option<[f32; 4]>,
    pub overflow_hidden: bool,
    pub opacity: Option<f32>,
    pub font: Option<Font>,
    pub image: Option<ImageRef>,
    pub render_mode: u8,
    pub division_disable: bool,
    pub page_break: bool,
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

#[derive(Clone)]
pub struct Border {
    pub w: [f32; 4], // top,right,bottom,left px
    pub c: [f32; 4], // rgba
    pub s: [u8; 4],  // 0 solid, 1 dashed
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
}

#[derive(Clone)]
pub struct ImageRef {
    pub id: u32,
    pub object_fit: u8,
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
    /// embed as /FlateDecode). Lets flat/line-art rasters avoid JPEG color loss.
    pub format: u8,
    pub bytes: Vec<u8>,
}

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

fn parse_hf(c: &mut Cursor) -> Result<HFSpec, String> {
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
        content,
        height_px,
        color: [cr, cg, cb, ca],
        font_size_px,
        position,
        custom,
        padding: [p0, p1, p2, p3],
    })
}

fn parse_opt_hf(c: &mut Cursor) -> Result<Option<HFSpec>, String> {
    Ok(if c.u8()? != 0 { Some(parse_hf(c)?) } else { None })
}

pub fn parse(data: &[u8]) -> Result<Snapshot, String> {
    let mut c = Cursor::new(data);
    let magic = c.bytes(4)?;
    if magic != b"D2P1" {
        return Err(format!("bad magic: {:?}", magic));
    }
    let version = c.u32()?;
    if version != 5 {
        return Err(format!("unsupported version {} (expected 5)", version));
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
        let header = parse_opt_hf(&mut c)?;
        let footer = parse_opt_hf(&mut c)?;
        Some((header, footer))
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
        let header = parse_opt_hf(&mut c)?;
        let footer = parse_opt_hf(&mut c)?;
        per_page_hf.push(PageHF { header, footer });
    }

    let config = Config {
        precision,
        pagination,
        single_page,
        background,
        header_h_px,
        footer_h_px,
        static_hf,
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
            let bc = [c.f32()?, c.f32()?, c.f32()?, c.f32()?];
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
            Some(BoxShadow {
                x: c.f32()?,
                y: c.f32()?,
                blur: c.f32()?,
                spread: c.f32()?,
                color: [c.f32()?, c.f32()?, c.f32()?, c.f32()?],
            })
        } else {
            None
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
            })
        } else {
            None
        };
        let render_mode = if flags & F_RENDER_MODE != 0 { c.u8()? } else { 0 };
        let division_disable = flags & F_DIVISION_DISABLE != 0;
        let page_break = flags & F_PAGE_BREAK != 0;
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
            text,
            lines,
        });
    }

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
        nodes,
        images,
    })
}
