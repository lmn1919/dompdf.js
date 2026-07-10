//! WASM entry (dependency-free, no wasm-bindgen).
//!
//! Exports (C ABI):
//!   alloc(n) -> ptr            allocate n bytes in WASM memory
//!   dealloc(ptr, n)            free an alloc'd buffer (capacity n)
//!   render_pdf(ptr, len) -> ptr  parse snapshot, emit PDF, return pointer to PDF bytes
//!   render_pdf_len() -> len     length of the last emitted PDF (0 on error)
//!   free_pdf(ptr, len)          free a PDF buffer returned by render_pdf
//!   inspect(ptr, len) -> ptr    parse + paginate, store a debug string, return its pointer
//!   inspect_len() -> len
//!
//! JS glue lives in packages/dom2pdf/src/wasm-glue.ts.

use std::sync::atomic::{AtomicUsize, Ordering};

mod encrypt;
mod font;
mod paginate;
mod pdf;
mod snapshot;
mod ttf;
mod deflate;

static OUT_LEN: AtomicUsize = AtomicUsize::new(0);
static INSPECT_LEN: AtomicUsize = AtomicUsize::new(0);
static mut INSPECT_PTR: usize = 0;

/// Allocate `n` bytes (uninitialized) in WASM memory and return the pointer.
#[no_mangle]
pub extern "C" fn alloc(n: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(n);
    let ptr = v.as_mut_ptr();
    std::mem::forget(v);
    ptr
}

/// Free a buffer previously allocated via `alloc` (pass the same capacity).
#[no_mangle]
pub extern "C" fn dealloc(ptr: *mut u8, n: usize) {
    if !ptr.is_null() && n > 0 {
        unsafe {
            let _ = Vec::from_raw_parts(ptr, 0, n);
        }
    }
}

/// Render a snapshot to PDF. Returns a pointer to the PDF bytes (owned by WASM,
/// must be copied out then freed with `free_pdf`). Length via `render_pdf_len`.
#[no_mangle]
pub extern "C" fn render_pdf(in_ptr: *const u8, in_len: usize) -> usize {
    render_pdf_inner(in_ptr, in_len, std::ptr::null(), 0)
}

#[no_mangle]
pub extern "C" fn render_pdf_encrypted(
    in_ptr: *const u8,
    in_len: usize,
    enc_ptr: *const u8,
    enc_len: usize,
) -> usize {
    render_pdf_inner(in_ptr, in_len, enc_ptr, enc_len)
}

fn render_pdf_inner(
    in_ptr: *const u8,
    in_len: usize,
    enc_ptr: *const u8,
    enc_len: usize,
) -> usize {
    let data = unsafe { std::slice::from_raw_parts(in_ptr, in_len) };
    let result = (|| -> Result<Vec<u8>, String> {
        let mut snap = snapshot::parse(data)?;
        let security = if !enc_ptr.is_null() && enc_len > 0 {
            let enc = unsafe { std::slice::from_raw_parts(enc_ptr, enc_len) };
            Some(encrypt::PdfSecurity::new(&encrypt::parse_config(enc)?))
        } else {
            None
        };
        let (pages, _total, fontctx, _single_h) = paginate::paginate(&mut snap)?;
        Ok(paginate::build_pdf(&snap, &pages, &fontctx, security.as_ref()))
    })();
    match result {
        Ok(bytes) => {
            let len = bytes.len();
            let boxed: Box<[u8]> = bytes.into_boxed_slice();
            let ptr = Box::into_raw(boxed) as *mut u8 as usize;
            OUT_LEN.store(len, Ordering::SeqCst);
            ptr
        }
        Err(_e) => {
            OUT_LEN.store(0, Ordering::SeqCst);
            0
        }
    }
}

/// Count pages for a snapshot (function-form pageConfig needs totalPages before
/// resolving per-page HF). Returns total page count; 0 on error.
#[no_mangle]
pub extern "C" fn count_pages(in_ptr: *const u8, in_len: usize) -> u32 {
    let data = unsafe { std::slice::from_raw_parts(in_ptr, in_len) };
    match snapshot::parse(data) {
        Ok(mut snap) => paginate::assign_pages(&mut snap),
        Err(_) => 0,
    }
}

#[no_mangle]
pub extern "C" fn render_pdf_len() -> usize {
    OUT_LEN.load(Ordering::SeqCst)
}

/// Free a PDF buffer returned by `render_pdf`.
#[no_mangle]
pub extern "C" fn free_pdf(ptr: usize, len: usize) {
    if ptr != 0 && len > 0 {
        unsafe {
            let slice = std::slice::from_raw_parts_mut(ptr as *mut u8, len);
            let _ = Box::from_raw(slice as *mut [u8]);
        }
    }
}

/// Inspect a snapshot: store a debug summary string, return its pointer.
#[no_mangle]
pub extern "C" fn inspect(in_ptr: *const u8, in_len: usize) -> usize {
    let data = unsafe { std::slice::from_raw_parts(in_ptr, in_len) };
    let s = match snapshot::parse(data) {
        Ok(mut snap) => {
            let (pages, total, _fontctx, _single_h) = match paginate::paginate(&mut snap) {
                Ok(v) => v,
                Err(e) => {
                    let s = format!("paginate error: {}", e);
                    let len = s.len();
                    let boxed = s.into_bytes().into_boxed_slice();
                    let ptr = Box::into_raw(boxed) as *mut u8 as usize;
                    unsafe {
                        INSPECT_PTR = ptr;
                    }
                    INSPECT_LEN.store(len, Ordering::SeqCst);
                    return ptr;
                }
            };
            let mut buf = format!(
                "nodes={} images={} fonts={} pages={}\n",
                snap.nodes.len(),
                snap.images.len(),
                snap.fonts.len(),
                total
            );
            for n in &snap.nodes {
                let kind = match n.kind {
                    0 => "box",
                    1 => "text",
                    2 => "image",
                    _ => "?",
                };
                buf.push_str(&format!(
                    "  #{} {} parent={} x={} y={} w={} h={} flags=0x{:04x}",
                    n.id, kind, n.parent, n.x, n.y, n.w, n.h, n.flags
                ));
                if let Some(t) = &n.text {
                    let preview: String = t.chars().take(40).collect();
                    buf.push_str(&format!(" text=\"{}\" lines={}", preview, n.lines.len()));
                    for l in &n.lines {
                        buf.push_str(&format!(
                            "\n      line y={} h={} start={} end={} page={} draw_y={}",
                            l.y, l.h, l.start, l.end, l.page, l.draw_y
                        ));
                    }
                }
                if let Some(img) = &n.image {
                    buf.push_str(&format!(" imageId={}", img.id));
                }
                buf.push('\n');
            }
            // Also dump all pages content (truncated per page).
            for (pi, p) in pages.iter().enumerate() {
                buf.push_str(&format!("--- page {} content ({} chars) ---\n", pi, p.content.len()));
                let head: String = p.content.chars().take(4000).collect();
                buf.push_str(&head);
                buf.push_str("\n");
            }
            // Also dump the per-draw_node debug log.
            let log = crate::paginate::DEBUG_LOG.with(|d| d.borrow().clone());
            buf.push_str("\n=== DEBUG LOG ===\n");
            buf.push_str(&log);
            buf
        }
        Err(e) => format!("error: {}", e),
    };
    let len = s.len();
    let boxed = s.into_bytes().into_boxed_slice();
    let ptr = Box::into_raw(boxed) as *mut u8 as usize;
    unsafe {
        INSPECT_PTR = ptr;
    }
    INSPECT_LEN.store(len, Ordering::SeqCst);
    ptr
}

#[no_mangle]
pub extern "C" fn inspect_len() -> usize {
    INSPECT_LEN.load(Ordering::SeqCst)
}
