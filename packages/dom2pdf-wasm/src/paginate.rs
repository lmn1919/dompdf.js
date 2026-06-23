//! Pagination + content stream generation + final PDF assembly.
//!
//! Page layout (PDF coords, origin bottom-left):
//!   margin_top band
//!   header band   (height header_h_pt)
//!   content band  (height content_h_pt)  <- nodes drawn here
//!   footer band   (height footer_h_pt)
//!   margin_bottom band
//!
//! content_h_pt = pageHeight - margins - header_h_pt - footer_h_pt.
//! Document y is CSS px (top-left origin); each page covers a content_h_px slice.

use crate::font::{encode_cid, encode_winansi, text_width_units, CidFont, FontCtx};
use crate::pdf::PdfWriter;
use crate::snapshot::{HFSpec, Image, Node, Snapshot};

pub const PX_TO_PT: f32 = 0.75;
const ASCENT: f32 = 0.8; // approx Helvetica ascent / em, for baseline placement

thread_local! {
    pub static DEBUG_LOG: std::cell::RefCell<String> = const { std::cell::RefCell::new(String::new()) };
    static PRECISION: std::cell::Cell<u8> = const { std::cell::Cell::new(2) };
}

pub struct PagePlan {
    pub content: String,
    pub image_ids: Vec<u32>,
    /// MediaBox height override (single-page mode); None = use pageHeightPt.
    pub media_h: Option<f32>,
}

fn precision() -> u8 {
    PRECISION.with(|p| p.get())
}

/// Format an f32 for PDF (trimmed). Never emits "-0".
fn f(x: f32) -> String {
    if x == 0.0 {
        return "0".to_string();
    }
    let p = precision().max(1) as i32;
    let scale = 10f32.powi(p);
    let r = (x * scale).round() / scale;
    if r == 0.0 {
        return "0".to_string();
    }
    let s = format!("{:.*}", p as usize, r);
    s.trim_end_matches('0')
        .trim_end_matches('.')
        .to_string()
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02X}", b));
    }
    s
}

fn opacity_key(opacity: f32) -> u16 {
    (opacity.clamp(0.0, 1.0) * 1000.0).round() as u16
}

fn opacity_resource_name(key: u16) -> String {
    format!("GS{}", key)
}

fn collapse_html_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_ws = false;
    for ch in text.chars() {
        if ch.is_ascii_whitespace() {
            in_ws = true;
            continue;
        }
        if in_ws {
            out.push(' ');
            in_ws = false;
        }
        out.push(ch);
    }
    if in_ws {
        out.push(' ');
    }
    out
}

fn approx_eq(a: f32, b: f32) -> bool {
    (a - b).abs() < 0.01
}

fn rounded_rect_radii_pt(node: &Node, w: f32, h: f32) -> Option<[f32; 4]> {
    let radius = node.radius?;
    let mut rtl = (radius[0] * PX_TO_PT).max(0.0);
    let mut rtr = (radius[1] * PX_TO_PT).max(0.0);
    let mut rbr = (radius[2] * PX_TO_PT).max(0.0);
    let mut rbl = (radius[3] * PX_TO_PT).max(0.0);
    let max_r = (w.min(h)) / 2.0;
    rtl = rtl.min(max_r);
    rtr = rtr.min(max_r);
    rbr = rbr.min(max_r);
    rbl = rbl.min(max_r);
    if rtl <= 0.0 && rtr <= 0.0 && rbr <= 0.0 && rbl <= 0.0 {
        None
    } else {
        Some([rtl, rtr, rbr, rbl])
    }
}

fn push_rounded_rect_path(
    out: &mut String,
    x0: f32,
    bottom: f32,
    w: f32,
    h: f32,
    radii: [f32; 4],
) {
    let [rtl, rtr, rbr, rbl] = radii;
    let top = bottom + h;
    let right = x0 + w;
    let k = 0.552_284_8_f32;

    out.push_str(&format!("{} {} m\n", f(x0 + rtl), f(top)));
    out.push_str(&format!("{} {} l\n", f(right - rtr), f(top)));
    if rtr > 0.0 {
        out.push_str(&format!(
            "{} {} {} {} {} {} c\n",
            f(right - rtr + rtr * k),
            f(top),
            f(right),
            f(top - rtr + rtr * k),
            f(right),
            f(top - rtr)
        ));
    }
    out.push_str(&format!("{} {} l\n", f(right), f(bottom + rbr)));
    if rbr > 0.0 {
        out.push_str(&format!(
            "{} {} {} {} {} {} c\n",
            f(right),
            f(bottom + rbr - rbr * k),
            f(right - rbr + rbr * k),
            f(bottom),
            f(right - rbr),
            f(bottom)
        ));
    }
    out.push_str(&format!("{} {} l\n", f(x0 + rbl), f(bottom)));
    if rbl > 0.0 {
        out.push_str(&format!(
            "{} {} {} {} {} {} c\n",
            f(x0 + rbl - rbl * k),
            f(bottom),
            f(x0),
            f(bottom + rbl - rbl * k),
            f(x0),
            f(bottom + rbl)
        ));
    }
    out.push_str(&format!("{} {} l\n", f(x0), f(top - rtl)));
    if rtl > 0.0 {
        out.push_str(&format!(
            "{} {} {} {} {} {} c\n",
            f(x0),
            f(top - rtl + rtl * k),
            f(x0 + rtl - rtl * k),
            f(top),
            f(x0 + rtl),
            f(top)
        ));
    }
    out.push_str("h\n");
}

fn uniform_border_width_pt(node: &Node) -> Option<f32> {
    let border = node.border.as_ref()?;
    if border.w.iter().all(|w| *w > 0.0)
        && approx_eq(border.w[0], border.w[1])
        && approx_eq(border.w[1], border.w[2])
        && approx_eq(border.w[2], border.w[3])
    {
        Some(border.w[0] * PX_TO_PT)
    } else {
        None
    }
}

fn uniform_border_style(node: &Node) -> Option<u8> {
    let border = node.border.as_ref()?;
    if border.s.iter().all(|s| *s == border.s[0]) {
        Some(border.s[0])
    } else {
        None
    }
}

fn dash_pattern_pt(style: u8, width_pt: f32) -> Option<(f32, f32)> {
    if style == 1 {
        let on = (width_pt * 3.0).max(1.0);
        let off = (width_pt * 2.0).max(1.0);
        Some((on, off))
    } else {
        None
    }
}

fn set_dash(out: &mut String, style: u8, width_pt: f32) {
    if let Some((on, off)) = dash_pattern_pt(style, width_pt) {
        out.push_str(&format!("[{} {}] 0 d\n", f(on), f(off)));
    } else {
        out.push_str("[] 0 d\n");
    }
}

fn compute_subtree_bounds(
    snap: &Snapshot,
    children: &[Vec<usize>],
    idx: usize,
    min_y: &mut [f32],
    max_y: &mut [f32],
) {
    let node = &snap.nodes[idx];
    let mut lo = node.y;
    let mut hi = node.y + node.h;
    for &child in children[idx].iter() {
        compute_subtree_bounds(snap, children, child, min_y, max_y);
        lo = lo.min(min_y[child]);
        hi = hi.max(max_y[child]);
    }
    min_y[idx] = lo;
    max_y[idx] = hi;
}

fn build_children(snap: &Snapshot) -> Vec<Vec<usize>> {
    let mut children: Vec<Vec<usize>> = vec![Vec::new(); snap.nodes.len()];
    for (i, n) in snap.nodes.iter().enumerate() {
        if n.parent >= 0 && (n.parent as usize) < snap.nodes.len() {
            children[n.parent as usize].push(i);
        }
    }
    children
}

fn collect_subtree(snap: &Snapshot, children: &[Vec<usize>], root: usize, out: &mut Vec<usize>) {
    out.push(root);
    for &c in children[root].iter() {
        collect_subtree(snap, children, c, out);
    }
}

fn shift_node_y(n: &mut Node, gap: f32) {
    n.y += gap;
    for l in n.lines.iter_mut() {
        l.y += gap;
        l.draw_y += gap;
    }
}

fn shift_lines_from(node: &mut Node, start: usize, gap: f32) {
    if gap == 0.0 {
        return;
    }
    for line in node.lines.iter_mut().skip(start) {
        line.y += gap;
        line.draw_y += gap;
    }
    node.h += gap;
}

/// Shift a subtree (node + descendants) by `gap` in document y.
fn shift_subtree(snap: &mut Snapshot, children: &[Vec<usize>], root: usize, gap: f32) {
    if gap == 0.0 {
        return;
    }
    let mut ids = Vec::new();
    collect_subtree(snap, children, root, &mut ids);
    for &i in ids.iter() {
        shift_node_y(&mut snap.nodes[i], gap);
    }
}

/// Shift the node subtree and every later node in document order so block-level
/// flow remains stable after pagination moves.
fn shift_flow_tail(snap: &mut Snapshot, children: &[Vec<usize>], root: usize, gap: f32) {
    if gap == 0.0 {
        return;
    }
    let mut ids = Vec::new();
    collect_subtree(snap, children, root, &mut ids);
    let tail_start = ids.iter().copied().max().map(|v| v + 1).unwrap_or(root + 1);
    shift_subtree(snap, children, root, gap);
    for i in tail_start..snap.nodes.len() {
        shift_node_y(&mut snap.nodes[i], gap);
    }
}

/// Apply pageBreak / divisionDisable by shifting subtrees in document space so
/// the existing geometric pagination naturally places them correctly.
fn apply_break_directives(snap: &mut Snapshot, children: &[Vec<usize>], content_h_px: f32) {
    if content_h_px <= 0.0 {
        return;
    }
    let roots: Vec<usize> = snap
        .nodes
        .iter()
        .enumerate()
        .filter(|(_, n)| n.parent < 0)
        .map(|(i, _)| i)
        .collect();

    // Pass 1: pageBreak — push node to the next page boundary (strictly greater).
    // Preorder so cascading breaks accumulate.
    fn walk_break(
        snap: &mut Snapshot,
        children: &[Vec<usize>],
        idx: usize,
        content_h_px: f32,
    ) {
        let pb = snap.nodes[idx].page_break;
        if pb {
            let y = snap.nodes[idx].y;
            let target = ((y / content_h_px).floor() + 1.0) * content_h_px;
            let gap = target - y;
            if gap > 0.0 {
                shift_flow_tail(snap, children, idx, gap);
            }
        }
        let kids: Vec<usize> = children[idx].clone();
        for c in kids {
            walk_break(snap, children, c, content_h_px);
        }
    }
    for &r in &roots {
        walk_break(snap, children, r, content_h_px);
    }

    // Pass 2: divisionDisable — if a box subtree straddles a page boundary and
    // fits within one page, move it to the next boundary. Iterate to stable.
    let mut subtree_min_y = vec![0.0_f32; snap.nodes.len()];
    let mut subtree_max_y = vec![0.0_f32; snap.nodes.len()];
    for &r in &roots {
        compute_subtree_bounds(snap, children, r, &mut subtree_min_y, &mut subtree_max_y);
    }
    for _ in 0..8 {
        let mut moved = false;
        let div_nodes: Vec<usize> = snap
            .nodes
            .iter()
            .enumerate()
            .filter(|(_, n)| n.division_disable && n.kind == 0)
            .map(|(i, _)| i)
            .collect();
        for &i in div_nodes.iter() {
            // recompute subtree bounds for i
            let mut lo = snap.nodes[i].y;
            let mut hi = snap.nodes[i].y + snap.nodes[i].h;
            let mut sub = Vec::new();
            collect_subtree(snap, children, i, &mut sub);
            for &s in sub.iter() {
                lo = lo.min(snap.nodes[s].y);
                hi = hi.max(snap.nodes[s].y + snap.nodes[s].h);
            }
            let top_page = (lo / content_h_px).floor();
            let bot_page = ((hi - 1e-3) / content_h_px).floor();
            if bot_page > top_page && (hi - lo) < content_h_px {
                let target = (top_page + 1.0) * content_h_px;
                let gap = target - lo;
                if gap > 0.0 {
                    shift_flow_tail(snap, children, i, gap);
                    moved = true;
                }
            }
        }
        if !moved {
            break;
        }
    }
}

/// Geometry derived from config + page size.
struct Geo {
    content_h_px: f32,
    content_h_pt: f32,
    header_h_pt: f32,
    footer_h_pt: f32,
}

fn compute_geo(snap: &Snapshot) -> Geo {
    let header_h_pt = snap.config.header_h_px * PX_TO_PT;
    let footer_h_pt = snap.config.footer_h_px * PX_TO_PT;
    let content_h_pt =
        snap.page_height_pt - snap.margin_top - snap.margin_bottom - header_h_pt - footer_h_pt;
    let content_h_pt = if content_h_pt > 0.0 {
        content_h_pt
    } else {
        snap.page_height_pt - snap.margin_top - snap.margin_bottom
    };
    let content_h_px = content_h_pt / PX_TO_PT;
    Geo {
        content_h_px,
        content_h_pt,
        header_h_pt,
        footer_h_pt,
    }
}

/// Assign each text line to a page; return total page count. Shared by
/// count_pages and the render path so they stay consistent.
pub fn assign_pages(snap: &mut Snapshot) -> u32 {
    PRECISION.with(|p| p.set(snap.config.precision.max(1).min(4)));

    if snap.config.single_page {
        for node in snap.nodes.iter_mut() {
            for line in node.lines.iter_mut() {
                line.page = 0;
                line.draw_y = line.y;
            }
        }
        return 1;
    }

    let geo = compute_geo(snap);
    let children = build_children(snap);
    apply_break_directives(snap, &children, geo.content_h_px);

    let content_h_px = geo.content_h_px;
    for idx in 0..snap.nodes.len() {
        let (_, right) = snap.nodes.split_at_mut(idx);
        let (node, tail) = right.split_first_mut().unwrap();
        if node.kind != 1 {
            continue;
        }
        for li in 0..node.lines.len() {
            let top = node.lines[li].y;
            let bottom = top + node.lines[li].h;
            let mut page = (top / content_h_px).floor() as i64;
            if page < 0 {
                page = 0;
            }
            let band_bottom = (page + 1) as f32 * content_h_px;
            if bottom > band_bottom && (bottom - top) < content_h_px {
                let gap = band_bottom - top;
                if gap > 0.0 {
                    // Preserve whitespace at the page break by inserting the gap
                    // into document flow instead of only snapping this one line.
                    shift_lines_from(node, li, gap);
                    for later in tail.iter_mut() {
                        shift_node_y(later, gap);
                    }
                }
                let moved_top = node.lines[li].y;
                page = (moved_top / content_h_px).floor() as i64;
                if page < 0 {
                    page = 0;
                }
                node.lines[li].draw_y = moved_top;
            } else {
                node.lines[li].draw_y = top;
            }
            if page < 0 {
                page = 0;
            }
            node.lines[li].page = page as u32;
        }
    }

    let mut max_page: u32 = 0;
    for node in snap.nodes.iter() {
        let bottom = node.y + node.h;
        let p = ((bottom - 1e-3) / content_h_px).floor() as i64;
        if p > max_page as i64 {
            max_page = p as u32;
        }
        for line in node.lines.iter() {
            if line.page > max_page {
                max_page = line.page;
            }
        }
    }
    max_page + 1
}

pub fn paginate(
    snap: &mut Snapshot,
) -> Result<(Vec<PagePlan>, u32, FontCtx, Option<f32>), String> {
    DEBUG_LOG.with(|d| d.borrow_mut().clear());
    let total = assign_pages(snap);
    let fontctx = FontCtx::build(&snap.fonts)?;
    collect_used_cid_gids(snap, &fontctx, total);
    let geo = compute_geo(snap);

    let children = build_children(snap);
    let roots: Vec<usize> = snap
        .nodes
        .iter()
        .enumerate()
        .filter(|(_, n)| n.parent < 0)
        .map(|(i, _)| i)
        .collect();
    let mut subtree_min_y = vec![0.0_f32; snap.nodes.len()];
    let mut subtree_max_y = vec![0.0_f32; snap.nodes.len()];
    for &r in roots.iter() {
        compute_subtree_bounds(snap, &children, r, &mut subtree_min_y, &mut subtree_max_y);
    }

    // Single-page MediaBox height = content + bands + margins.
    let single_media_h = if snap.config.single_page {
        let max_bottom = snap
            .nodes
            .iter()
            .map(|n| n.y + n.h)
            .fold(0.0_f32, f32::max);
        Some(
            snap.margin_top + geo.header_h_pt + max_bottom * PX_TO_PT + geo.footer_h_pt
                + snap.margin_bottom,
        )
    } else {
        None
    };

    let mut pages = Vec::with_capacity(total as usize);
    for i in 0..total {
        let mut content = String::new();
        let cx = snap.margin_left;
        let cy = snap.margin_bottom + geo.footer_h_pt;
        let cw = snap.page_width_pt - snap.margin_left - snap.margin_right;
        let ch = geo.content_h_pt;
        content.push_str("q\n");
        // background fill (within page media box, full page)
        if let Some(bg) = snap.config.background {
            if bg[3] > 0.001 {
                content.push_str(&format!(
                    "{} {} {} rg 0 0 {} {} re f\n",
                    f(bg[0]),
                    f(bg[1]),
                    f(bg[2]),
                    f(snap.page_width_pt),
                    f(snap.page_height_pt)
                ));
            }
        }
        content.push_str(&format!(
            "{} {} {} {} re W n\n",
            f(cx),
            f(cy),
            f(cw),
            f(ch)
        ));
        let mut image_ids: Vec<u32> = Vec::new();
        for &r in roots.iter() {
            draw_node(
                snap,
                &fontctx,
                &children,
                &subtree_min_y,
                &subtree_max_y,
                r,
                i,
                geo.content_h_px,
                &mut content,
                &mut image_ids,
            );
        }
        content.push_str("Q\n");

        // Header / footer (drawn outside the content clip).
        draw_header_footer(snap, &fontctx, i, total, &geo, &mut content);

        pages.push(PagePlan {
            content,
            image_ids,
            media_h: single_media_h,
        });
    }
    Ok((pages, total, fontctx, single_media_h))
}

fn rect_pt(snap: &Snapshot, geo: &Geo, node: &Node, page: u32, content_h_px: f32) -> (f32, f32, f32, f32) {
    let x0 = snap.margin_left + node.x * PX_TO_PT;
    let top_pt = snap.page_height_pt - snap.margin_top - geo.header_h_pt
        - (node.y - page as f32 * content_h_px) * PX_TO_PT;
    let w = node.w * PX_TO_PT;
    let h = node.h * PX_TO_PT;
    let bottom = top_pt - h;
    (x0, bottom, w, h)
}

fn find_image<'a>(snap: &'a Snapshot, image_id: u32) -> Option<&'a Image> {
    snap.images.iter().find(|img| img.id == image_id)
}

fn image_draw_rect_pt(node: &Node, img: &Image, box_x: f32, box_bottom: f32, box_w: f32, box_h: f32) -> (f32, f32, f32, f32) {
    let natural_w = (img.width as f32).max(1.0) * PX_TO_PT;
    let natural_h = (img.height as f32).max(1.0) * PX_TO_PT;
    let fit = node.image.as_ref().map(|r| r.object_fit).unwrap_or(0);
    let (draw_w, draw_h) = match fit {
        1 => {
            let s = (box_w / natural_w).min(box_h / natural_h);
            (natural_w * s, natural_h * s)
        }
        2 => {
            let s = (box_w / natural_w).max(box_h / natural_h);
            (natural_w * s, natural_h * s)
        }
        3 => (natural_w, natural_h),
        4 => {
            let s = (box_w / natural_w).min(box_h / natural_h).min(1.0);
            (natural_w * s, natural_h * s)
        }
        _ => (box_w, box_h),
    };
    let draw_x = box_x + (box_w - draw_w) / 2.0;
    let draw_y = box_bottom + (box_h - draw_h) / 2.0;
    (draw_x, draw_y, draw_w, draw_h)
}

fn image_needs_clip(node: &Node, draw_w: f32, draw_h: f32, box_w: f32, box_h: f32) -> bool {
    node.radius.is_some()
        || draw_w > box_w + 0.01
        || draw_h > box_h + 0.01
}

fn draw_node(
    snap: &Snapshot,
    fontctx: &FontCtx,
    children: &[Vec<usize>],
    subtree_min_y: &[f32],
    subtree_max_y: &[f32],
    idx: usize,
    page: u32,
    content_h_px: f32,
    out: &mut String,
    image_ids: &mut Vec<u32>,
) {
    let node = &snap.nodes[idx];
    if node.render_mode == 2 {
        return;
    }

    let band_top = page as f32 * content_h_px;
    let band_bottom = (page + 1) as f32 * content_h_px;
    if subtree_min_y[idx] >= band_bottom || subtree_max_y[idx] <= band_top {
        return;
    }
    let vis = node.y < band_bottom && (node.y + node.h) > band_top;
    let geo = compute_geo(snap);
    let opacity = node.opacity.unwrap_or(1.0).clamp(0.0, 1.0);
    let use_opacity = opacity < 0.999;
    if use_opacity {
        out.push_str("q\n");
        out.push_str(&format!("/{} gs\n", opacity_resource_name(opacity_key(opacity))));
    }

    match node.kind {
        0 => {
            if vis && node.render_mode == 0 {
                draw_box(snap, &geo, node, page, content_h_px, out);
            }
            let clip = vis && node.overflow_hidden;
            if clip {
                out.push_str("q\n");
                let (x0, bottom, w, h) = rect_pt(snap, &geo, node, page, content_h_px);
                if let Some(radii) = rounded_rect_radii_pt(node, w, h) {
                    push_rounded_rect_path(out, x0, bottom, w, h, radii);
                    out.push_str("W n\n");
                } else {
                    out.push_str(&format!(
                        "{} {} {} {} re W n\n",
                        f(x0),
                        f(bottom),
                        f(w),
                        f(h)
                    ));
                }
            }
            for &c in children[idx].iter() {
                draw_node(
                    snap,
                    fontctx,
                    children,
                    subtree_min_y,
                    subtree_max_y,
                    c,
                    page,
                    content_h_px,
                    out,
                    image_ids,
                );
            }
            if clip {
                out.push_str("Q\n");
            }
        }
        1 => {
            if node.render_mode != 2 {
                draw_text_lines(snap, fontctx, &geo, node, page, content_h_px, out);
            }
        }
        2 => {
            if vis && node.render_mode != 2 {
                draw_box_bg(snap, &geo, node, page, content_h_px, out);
                if let Some(img) = node.image.as_ref() {
                    if let Some(src) = find_image(snap, img.id) {
                        let (x0, bottom, w, h) = rect_pt(snap, &geo, node, page, content_h_px);
                        let (draw_x, draw_y, draw_w, draw_h) = image_draw_rect_pt(node, src, x0, bottom, w, h);
                        let needs_clip = image_needs_clip(node, draw_w, draw_h, w, h);
                        if needs_clip {
                            out.push_str("q\n");
                            if let Some(radii) = rounded_rect_radii_pt(node, w, h) {
                                push_rounded_rect_path(out, x0, bottom, w, h, radii);
                                out.push_str("W n\n");
                            } else {
                                out.push_str(&format!(
                                    "{} {} {} {} re W n\n",
                                    f(x0),
                                    f(bottom),
                                    f(w),
                                    f(h)
                                ));
                            }
                        }
                        out.push_str(&format!(
                            "q {} 0 0 {} {} {} cm /Im{} Do Q\n",
                            f(draw_w),
                            f(draw_h),
                            f(draw_x),
                            f(draw_y),
                            img.id
                        ));
                        if needs_clip {
                            out.push_str("Q\n");
                        }
                        if !image_ids.contains(&img.id) {
                            image_ids.push(img.id);
                        }
                    }
                }
                draw_box_border(snap, &geo, node, page, content_h_px, out);
            }
        }
        _ => {}
    }
    if use_opacity {
        out.push_str("Q\n");
    }
}

fn draw_box_bg(snap: &Snapshot, geo: &Geo, node: &Node, page: u32, content_h_px: f32, out: &mut String) {
    let (x0, bottom, w, h) = rect_pt(snap, geo, node, page, content_h_px);
    let radii = rounded_rect_radii_pt(node, w, h);
    if let Some(bg) = node.bg {
        if bg[3] > 0.001 {
            out.push_str(&format!("{} {} {} rg\n", f(bg[0]), f(bg[1]), f(bg[2])));
            if let Some(radii) = radii {
                push_rounded_rect_path(out, x0, bottom, w, h, radii);
                out.push_str("f\n");
            } else {
                out.push_str(&format!("{} {} {} {} re f\n", f(x0), f(bottom), f(w), f(h)));
            }
        }
    }
}

fn draw_box_border(snap: &Snapshot, geo: &Geo, node: &Node, page: u32, content_h_px: f32, out: &mut String) {
    let (x0, bottom, w, h) = rect_pt(snap, geo, node, page, content_h_px);
    let radii = rounded_rect_radii_pt(node, w, h);
    if let Some(b) = &node.border {
        if let (Some(radii), Some(bw), Some(style)) =
            (radii, uniform_border_width_pt(node), uniform_border_style(node))
        {
            out.push_str(&format!("{} {} {} RG {} w\n", f(b.c[0]), f(b.c[1]), f(b.c[2]), f(bw)));
            set_dash(out, style, bw);
            push_rounded_rect_path(out, x0, bottom, w, h, radii);
            out.push_str("S\n");
            out.push_str("[] 0 d\n");
            return;
        }
        let top_pt = bottom + h;
        let right = x0 + w;
        if b.w[0] > 0.0 {
            let bw = b.w[0] * PX_TO_PT;
            out.push_str(&format!(
                "{} {} {} RG {} w\n",
                f(b.c[0]), f(b.c[1]), f(b.c[2]), f(bw)
            ));
            set_dash(out, b.s[0], bw);
            out.push_str(&format!(
                "{} {} m {} {} l S\n",
                f(x0), f(top_pt), f(right), f(top_pt)
            ));
            out.push_str("[] 0 d\n");
        }
        if b.w[1] > 0.0 {
            let bw = b.w[1] * PX_TO_PT;
            out.push_str(&format!(
                "{} {} {} RG {} w\n",
                f(b.c[0]), f(b.c[1]), f(b.c[2]), f(bw)
            ));
            set_dash(out, b.s[1], bw);
            out.push_str(&format!(
                "{} {} m {} {} l S\n",
                f(right), f(top_pt), f(right), f(bottom)
            ));
            out.push_str("[] 0 d\n");
        }
        if b.w[2] > 0.0 {
            let bw = b.w[2] * PX_TO_PT;
            out.push_str(&format!(
                "{} {} {} RG {} w\n",
                f(b.c[0]), f(b.c[1]), f(b.c[2]), f(bw)
            ));
            set_dash(out, b.s[2], bw);
            out.push_str(&format!(
                "{} {} m {} {} l S\n",
                f(x0), f(bottom), f(right), f(bottom)
            ));
            out.push_str("[] 0 d\n");
        }
        if b.w[3] > 0.0 {
            let bw = b.w[3] * PX_TO_PT;
            out.push_str(&format!(
                "{} {} {} RG {} w\n",
                f(b.c[0]), f(b.c[1]), f(b.c[2]), f(bw)
            ));
            set_dash(out, b.s[3], bw);
            out.push_str(&format!(
                "{} {} m {} {} l S\n",
                f(x0), f(top_pt), f(x0), f(bottom)
            ));
            out.push_str("[] 0 d\n");
        }
    }
}

fn draw_box(snap: &Snapshot, geo: &Geo, node: &Node, page: u32, content_h_px: f32, out: &mut String) {
    draw_box_bg(snap, geo, node, page, content_h_px, out);
    draw_box_border(snap, geo, node, page, content_h_px, out);
}

/// Resolve `${currentPage}` / `${totalPages}` placeholders.
fn resolve_placeholders(content: &str, page: u32, total: u32) -> String {
    content
        .replace("${currentPage}", &format!("{}", page + 1))
        .replace("${totalPages}", &format!("{}", total))
}

/// Whether text contains any char outside the WinAnsi range.
fn has_non_latin(s: &str) -> bool {
    s.chars().any(|c| {
        let u = c as u32;
        u > 0xFF && !matches!(u, 0x20AC | 0x201A | 0x0192 | 0x201E | 0x2026 | 0x2020
            | 0x2021 | 0x02C6 | 0x2030 | 0x0160 | 0x2039 | 0x0152 | 0x017D
            | 0x2018 | 0x2019 | 0x201C | 0x201D | 0x2022 | 0x2013 | 0x2014
            | 0x02DC | 0x2122 | 0x0161 | 0x203A | 0x0153 | 0x017E | 0x0178)
    })
}

fn latin_font_token(weight: u16, italic: u8) -> &'static str {
    if weight >= 700 {
        if italic != 0 { "/F1BI" } else { "/F1B" }
    } else if italic != 0 {
        "/F1I"
    } else {
        "/F1"
    }
}

fn select_cid_font<'a>(
    fontctx: &'a FontCtx,
    family: &str,
    weight: u16,
    italic: u8,
    text: &str,
) -> Option<&'a CidFont> {
    fontctx
        .select(family, weight, italic)
        .or_else(|| if has_non_latin(text) { fontctx.first_cid() } else { None })
}

fn collect_used_cid_run(fontctx: &FontCtx, family: &str, weight: u16, italic: u8, text: &str) {
    let normalized = collapse_html_whitespace(text);
    if normalized.is_empty() {
        return;
    }
    if let Some(cf) = select_cid_font(fontctx, family, weight, italic, &normalized) {
        let _ = encode_cid(cf, &normalized);
    }
}

fn collect_used_cid_gids(snap: &Snapshot, fontctx: &FontCtx, total: u32) {
    for node in snap.nodes.iter() {
        if node.kind != 1 {
            continue;
        }
        let font = match node.font.as_ref() {
            Some(f) => f,
            None => continue,
        };
        let txt = match node.text.as_ref() {
            Some(t) => t,
            None => continue,
        };
        for line in node.lines.iter() {
            let txt_len = txt.len();
            let s = (line.start as usize).min(txt_len);
            let e = (line.end as usize).min(txt_len);
            if e <= s {
                continue;
            }
            collect_used_cid_run(fontctx, &font.family, font.weight, font.italic, &txt[s..e]);
        }
    }

    for page in 0..total {
        let (header, footer) = if !snap.per_page_hf.is_empty() {
            let i = (page as usize).min(snap.per_page_hf.len() - 1);
            let hf = &snap.per_page_hf[i];
            (hf.header.as_ref(), hf.footer.as_ref())
        } else if let Some((h, f)) = &snap.config.static_hf {
            (h.as_ref(), f.as_ref())
        } else {
            (None, None)
        };
        if let Some(h) = header {
            let content = resolve_placeholders(&h.content, page, total);
            collect_used_cid_run(fontctx, "Helvetica", 400, 0, &content);
        }
        if let Some(f) = footer {
            let content = resolve_placeholders(&f.content, page, total);
            collect_used_cid_run(fontctx, "Helvetica", 400, 0, &content);
        }
    }

    fontctx.prepare_subset_maps();
}

fn draw_text_lines(
    snap: &Snapshot,
    fontctx: &FontCtx,
    geo: &Geo,
    node: &Node,
    page: u32,
    content_h_px: f32,
    out: &mut String,
) {
    let font = match node.font.as_ref() {
        Some(f) => f,
        None => return,
    };
    let txt = match node.text.as_ref() {
        Some(t) => t,
        None => return,
    };
    let fs_pt = font.size_px * PX_TO_PT;
    let color = font.color;
    let color_op = if color[0] == 0.0 && color[1] == 0.0 && color[2] == 0.0 {
        String::new()
    } else {
        format!("{} {} {} rg\n", f(color[0]), f(color[1]), f(color[2]))
    };

    for line in node.lines.iter() {
        if line.page != page {
            continue;
        }
        let txt_len = txt.len();
        let s = (line.start as usize).min(txt_len);
        let mut e = (line.end as usize).min(txt_len);
        if e < s {
            e = s;
        }
        if e <= s {
            continue;
        }
        let seg = &txt[s..e];
        if seg.is_empty() {
            continue;
        }
        let normalized = collapse_html_whitespace(seg);
        if normalized.is_empty() {
            continue;
        }
        let cid = select_cid_font(fontctx, &font.family, font.weight, font.italic, &normalized);

        let baseline_px = line.draw_y + (line.h - font.size_px) / 2.0 + ASCENT * font.size_px;
        let y_pt = snap.page_height_pt - snap.margin_top - geo.header_h_pt
            - (baseline_px - page as f32 * content_h_px) * PX_TO_PT;

        out.push_str(&color_op);
        out.push_str("BT\n");

        if let Some(cf) = cid {
            let (gbytes, width_1000) = encode_cid(cf, &normalized);
            if gbytes.is_empty() {
                out.push_str("ET\n");
                continue;
            }
            let space_count = normalized.chars().filter(|c| *c == ' ').count() as f32;
            let extra_px = font.letter_spacing_px * (normalized.chars().count() as f32)
                + font.word_spacing_px * space_count;
            let text_w_px = (width_1000 as f32 / 1000.0) * font.size_px + extra_px;
            let x_pt = match font.align {
                1 => snap.margin_left + (line.x + line.w - text_w_px) * PX_TO_PT,
                2 => snap.margin_left + (line.x + line.w / 2.0 - text_w_px / 2.0) * PX_TO_PT,
                _ => snap.margin_left + line.x * PX_TO_PT,
            };
            let tc = if font.letter_spacing_px != 0.0 {
                font.letter_spacing_px * PX_TO_PT
            } else {
                0.0
            };
            let tw = if font.word_spacing_px != 0.0 {
                font.word_spacing_px * PX_TO_PT
            } else {
                0.0
            };
            out.push_str(&format!("/F{} {} Tf\n", cf.key, f(fs_pt)));
            out.push_str(&format!("{} Tc\n", f(tc)));
            out.push_str(&format!("{} Tw\n", f(tw)));
            out.push_str(&format!("1 0 0 1 {} {} Tm\n", f(x_pt), f(y_pt)));
            out.push_str(&format!("<{}> Tj\n", hex(&gbytes)));
        } else {
            let bytes = encode_winansi(&normalized);
            if bytes.is_empty() {
                out.push_str("ET\n");
                continue;
            }
            let width_units = text_width_units(&bytes);
            let space_count = bytes.iter().filter(|&&b| b == b' ').count() as f32;
            let extra_px = font.letter_spacing_px * (bytes.len() as f32)
                + font.word_spacing_px * space_count;
            let text_w_px = (width_units as f32 / 1000.0) * font.size_px + extra_px;
            let x_pt = match font.align {
                1 => snap.margin_left + (line.x + line.w - text_w_px) * PX_TO_PT,
                2 => snap.margin_left + (line.x + line.w / 2.0 - text_w_px / 2.0) * PX_TO_PT,
                _ => snap.margin_left + line.x * PX_TO_PT,
            };
            let tc = if font.letter_spacing_px != 0.0 {
                font.letter_spacing_px * PX_TO_PT
            } else {
                0.0
            };
            let tw = if font.word_spacing_px != 0.0 {
                font.word_spacing_px * PX_TO_PT
            } else {
                0.0
            };
            out.push_str(&format!("{} {} Tf\n", latin_font_token(font.weight, font.italic), f(fs_pt)));
            out.push_str(&format!("{} Tc\n", f(tc)));
            out.push_str(&format!("{} Tw\n", f(tw)));
            out.push_str(&format!("1 0 0 1 {} {} Tm\n", f(x_pt), f(y_pt)));
            out.push_str(&format!("<{}> Tj\n", hex(&bytes)));
        }
        out.push_str("ET\n");
    }
}

/// Draw a single header/footer region text into `out`.
fn draw_hf_region(
    snap: &Snapshot,
    fontctx: &FontCtx,
    spec: &HFSpec,
    page: u32,
    total: u32,
    _geo: &Geo,
    is_header: bool,
    out: &mut String,
) {
    let content = resolve_placeholders(&spec.content, page, total);
    let normalized = collapse_html_whitespace(&content);
    if normalized.is_empty() {
        return;
    }
    let fs_pt = spec.font_size_px * PX_TO_PT;
    let color = spec.color;
    let [pt, pr, pb, pl] = spec.padding;

    // Band rect in PDF coords.
    let band_h_pt = spec.height_px * PX_TO_PT;
    let (band_top, band_bottom) = if is_header {
        let top = snap.page_height_pt - snap.margin_top;
        (top, top - band_h_pt)
    } else {
        let bottom = snap.margin_bottom;
        (bottom + band_h_pt, bottom)
    };
    let inner_left = snap.margin_left + pl * PX_TO_PT;
    let inner_right = snap.page_width_pt - snap.margin_right - pr * PX_TO_PT;
    let inner_top = band_top - pt * PX_TO_PT;
    let inner_bottom = band_bottom + pb * PX_TO_PT;
    let inner_w = (inner_right - inner_left).max(0.0);
    let inner_h = (inner_top - inner_bottom).max(0.0);

    // Choose font + measure width.
    let non_latin = has_non_latin(&normalized);
    let cf = if non_latin {
        fontctx.first_cid()
    } else {
        None
    };
    let (bytes, text_w_pt) = if let Some(cf) = cf {
        let (gb, w1000) = encode_cid(cf, &normalized);
        (gb, (w1000 as f32 / 1000.0) * fs_pt)
    } else {
        let b = encode_winansi(&normalized);
        let w = (text_width_units(&b) as f32 / 1000.0) * fs_pt;
        (b, w)
    };
    if bytes.is_empty() {
        return;
    }

    // Horizontal placement.
    let x_pt = match spec.position {
        1 => inner_left,                                  // centerLeft
        2 => inner_right - text_w_pt,                     // centerRight
        5 => inner_left,                                  // leftTop
        6 => inner_left,                                  // leftBottom
        7 => inner_right - text_w_pt,                     // rightTop
        8 => inner_right - text_w_pt,                     // rightBottom
        9 => spec.custom.map(|(x, _)| snap.margin_left + x * PX_TO_PT).unwrap_or(inner_left),
        _ => inner_left + (inner_w - text_w_pt) / 2.0,    // center / centerTop / centerBottom
    };
    // Vertical baseline placement.
    let y_pt = match spec.position {
        3 | 5 | 7 => inner_top - ASCENT * fs_pt,          // top-aligned
        4 | 6 | 8 => inner_bottom + (1.0 - ASCENT) * fs_pt, // bottom-aligned
        9 => spec
            .custom
            .map(|(_, y)| band_bottom + (band_top - band_bottom) - y * PX_TO_PT - ASCENT * fs_pt)
            .unwrap_or_else(|| inner_bottom + inner_h / 2.0 - (fs_pt / 2.0) + ASCENT * fs_pt / 2.0),
        _ => inner_bottom + (inner_h - fs_pt) / 2.0 + ASCENT * fs_pt, // vertically centered
    };

    out.push_str(&format!(
        "{} {} {} rg\nBT\n",
        f(color[0]),
        f(color[1]),
        f(color[2])
    ));
    let font_op = if cf.is_some() {
        format!("/F{} {} Tf\n", cf.unwrap().key, f(fs_pt))
    } else {
        format!("{} {} Tf\n", latin_font_token(400, 0), f(fs_pt))
    };
    out.push_str(&font_op);
    out.push_str(&format!("1 0 0 1 {} {} Tm\n", f(x_pt), f(y_pt)));
    out.push_str(&format!("<{}> Tj\nET\n", hex(&bytes)));
}

fn draw_header_footer(
    snap: &Snapshot,
    fontctx: &FontCtx,
    page: u32,
    total: u32,
    geo: &Geo,
    out: &mut String,
) {
    // Resolve which HF applies to this page.
    let (header, footer) = if !snap.per_page_hf.is_empty() {
        // function-form: per-page resolved by JS
        let i = (page as usize).min(snap.per_page_hf.len() - 1);
        let hf = &snap.per_page_hf[i];
        (hf.header.as_ref(), hf.footer.as_ref())
    } else if let Some((h, f)) = &snap.config.static_hf {
        // object-form: same for every page
        (h.as_ref(), f.as_ref())
    } else {
        (None, None)
    };
    if let Some(h) = header {
        draw_hf_region(snap, fontctx, h, page, total, geo, true, out);
    }
    if let Some(f) = footer {
        draw_hf_region(snap, fontctx, f, page, total, geo, false, out);
    }
}

/// Build a ToUnicode CMap stream for a CID font, covering used gids.
fn build_tounicode(cf: &crate::font::CidFont) -> Vec<u8> {
    let used = cf.used_gids.borrow();
    let mut entries: Vec<(u16, u32)> = used
        .iter()
        .filter_map(|&gid| {
            cf.gid_to_unicode
                .get(&gid)
                .map(|&cp| (cf.subset_gid(gid), cp))
        })
        .collect();
    entries.sort_by_key(|&(g, _)| g);

    let mut s = String::new();
    s.push_str("/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n");
    s.push_str("/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n");
    s.push_str("/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n");
    s.push_str("1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n");
    // bfchar in batches of <=100.
    let mut i = 0;
    while i < entries.len() {
        let chunk = (entries.len() - i).min(100);
        s.push_str(&format!("{} beginbfchar\n", chunk));
        for j in i..i + chunk {
            let (gid, cp) = entries[j];
            s.push_str(&format!("<{:04X}> <{:04X}>\n", gid, cp));
        }
        s.push_str("endbfchar\n");
        i += chunk;
    }
    s.push_str("endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n");
    s.into_bytes()
}

/// Assemble the full PDF document from the snapshot and page plans.
pub fn build_pdf(snap: &Snapshot, pages: &[PagePlan], fontctx: &FontCtx) -> Vec<u8> {
    DEBUG_LOG.with(|d| {
        d.borrow_mut().push_str("\n--- DEBUG LOG END ---\n");
    });
    let mut w = PdfWriter::new();
    w.header();

    let catalog_id = w.alloc(1);
    let pages_id = w.alloc(1);
    let page_count = pages.len() as u32;
    let page_ids_first = w.alloc(page_count);
    let content_ids_first = w.alloc(page_count);
    let helvetica_first_id = w.alloc(4);
    let cid_count = fontctx.cid.len() as u32;
    // For each CID font: ToUnicode, FontFile2, FontDescriptor, CIDFont, Type0 = 5 objects.
    let cid_objs_first = w.alloc(cid_count * 5);
    let image_count = snap.images.len() as u32;
    let image_ids_first = w.alloc(image_count);
    let opacity_keys: std::collections::BTreeSet<u16> = snap
        .nodes
        .iter()
        .filter_map(|n| n.opacity)
        .map(opacity_key)
        .filter(|k| *k < 1000)
        .collect();
    let opacity_count = opacity_keys.len() as u32;
    let opacity_first_id = w.alloc(opacity_count);

    // Image XObjects.
    let mut image_obj_for: std::collections::HashMap<u32, u32> = std::collections::HashMap::new();
    for (i, img) in snap.images.iter().enumerate() {
        let oid = image_ids_first + i as u32;
        image_obj_for.insert(img.id, oid);
        let dict = format!(
            " /Type /XObject /Subtype /Image /Width {} /Height {} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode",
            img.width, img.height
        );
        w.stream(oid, &dict, &img.bytes);
    }

    // Helvetica (Base14, not embedded).
    w.indirect(
        helvetica_first_id,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    );
    w.indirect(
        helvetica_first_id + 1,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    );
    w.indirect(
        helvetica_first_id + 2,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>",
    );
    w.indirect(
        helvetica_first_id + 3,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-BoldOblique /Encoding /WinAnsiEncoding >>",
    );

    // CID fonts (Type0 + CIDFontType2 + FontDescriptor + FontFile2 + ToUnicode).
    let mut cid_type0_ids: Vec<u32> = Vec::with_capacity(fontctx.cid.len());
    for (i, cf) in fontctx.cid.iter().enumerate() {
        let base = cid_objs_first + (i as u32) * 5;
        let tounicode_id = base;
        let fontfile_id = base + 1;
        let descriptor_id = base + 2;
        let cidfont_id = base + 3;
        let type0_id = base + 4;
        cid_type0_ids.push(type0_id);

        // ToUnicode
        let tu = build_tounicode(cf);
        w.stream(tounicode_id, " /Type /CMap /N 1", &tu);

        // FontFile2
        let used = cf.used_gids.borrow();
        let embed = cf.ttf.embed_bytes(&used);
        let ff2_extra = format!(" /Length1 {}", embed.len());
        w.stream(fontfile_id, &ff2_extra, &embed);

        let bbox = cf.ttf.bbox_1000();
        let ascent = cf.ttf.ascent_1000();
        let descent = cf.ttf.descent_1000();
        let flags = 4; // Symbolic
        let fontname = format!("CidFont{}", cf.key);

        // FontDescriptor
        let fd = format!(
            "<< /Type /FontDescriptor /FontName /{} /Flags {} /FontBBox [{} {} {} {}] /ItalicAngle 0 /Ascent {} /Descent {} /CapHeight {} /StemV 80 /FontFile2 {} 0 R >>",
            fontname, flags,
            bbox[0], bbox[1], bbox[2], bbox[3],
            ascent, descent, ascent, fontfile_id
        );
        w.indirect(descriptor_id, &fd);

        // W array: widths for used gids (1/1000 em).
        let mut w_entries: Vec<(u16, u32)> = used
            .iter()
            .map(|&g| (cf.subset_gid(g), cf.ttf.width_1000(g)))
            .collect();
        w_entries.sort_by_key(|&(g, _)| g);
        let mut w_str = String::from("/W [");
        for (gid, width) in w_entries.iter() {
            w_str.push_str(&format!(" {} [{}]", gid, width));
        }
        w_str.push_str(" ] ");

        // CIDFontType2
        let cid_dict = format!(
            "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /{} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor {} 0 R /CIDToGIDMap /Identity /DW 1000 {} >>",
            fontname, descriptor_id, w_str
        );
        w.indirect(cidfont_id, &cid_dict);

        // Type0
        let type0_dict = format!(
            "<< /Type /Font /Subtype /Type0 /BaseFont /{} /Encoding /Identity-H /DescendantFonts [ {} 0 R ] /ToUnicode {} 0 R >>",
            fontname, cidfont_id, tounicode_id
        );
        w.indirect(type0_id, &type0_dict);
    }

    // ExtGState resources for node opacity.
    let mut opacity_obj_for: std::collections::BTreeMap<u16, u32> = std::collections::BTreeMap::new();
    for (i, key) in opacity_keys.iter().enumerate() {
        let oid = opacity_first_id + i as u32;
        opacity_obj_for.insert(*key, oid);
        let alpha = (*key as f32) / 1000.0;
        let body = format!("<< /Type /ExtGState /ca {} /CA {} >>", f(alpha), f(alpha));
        w.indirect(oid, &body);
    }

    // Content streams.
    for (i, p) in pages.iter().enumerate() {
        let cid = content_ids_first + i as u32;
        w.stream(cid, "", p.content.as_bytes());
    }

    // Page objects.
    let mut kids = String::new();
    for i in 0..page_count {
        let pid = page_ids_first + i;
        let cid = content_ids_first + i;
        let p = &pages[i as usize];
        let mut font_dict = format!(
            "/Font << /F1 {} 0 R /F1B {} 0 R /F1I {} 0 R /F1BI {} 0 R",
            helvetica_first_id,
            helvetica_first_id + 1,
            helvetica_first_id + 2,
            helvetica_first_id + 3
        );
        for (j, type0_id) in cid_type0_ids.iter().enumerate() {
            let key = 2 + j as u32;
            font_dict.push_str(&format!(" /F{} {} 0 R", key, type0_id));
        }
        font_dict.push_str(" >> ");
        let mut xobj = String::new();
        if !p.image_ids.is_empty() {
            xobj.push_str("/XObject << ");
            for id in p.image_ids.iter() {
                if let Some(&oid) = image_obj_for.get(id) {
                    xobj.push_str(&format!("/Im{} {} 0 R ", id, oid));
                }
            }
            xobj.push_str(">> ");
        }
        let mut extgstate = String::new();
        if !opacity_obj_for.is_empty() {
            extgstate.push_str("/ExtGState << ");
            for (key, oid) in opacity_obj_for.iter() {
                extgstate.push_str(&format!("/{} {} 0 R ", opacity_resource_name(*key), oid));
            }
            extgstate.push_str(">> ");
        }
        let media_h = p.media_h.unwrap_or(snap.page_height_pt);
        let body = format!(
            "<< /Type /Page /Parent {pages} 0 R /MediaBox [0 0 {pw} {ph}] /Resources << {font}{xobj}{extgstate}>> /Contents {cid} 0 R >>",
            pages = pages_id,
            pw = f(snap.page_width_pt),
            ph = f(media_h),
            font = font_dict,
            xobj = xobj,
            extgstate = extgstate,
            cid = cid,
        );
        w.indirect(pid, &body);
        kids.push_str(&format!("{} 0 R ", pid));
    }

    w.indirect(
        pages_id,
        &format!(
            "<< /Type /Pages /Kids [ {} ] /Count {} >>",
            kids.trim(),
            page_count
        ),
    );

    w.indirect(
        catalog_id,
        &format!("<< /Type /Catalog /Pages {} 0 R >>", pages_id),
    );

    w.finish(catalog_id);
    w.into_bytes()
}
