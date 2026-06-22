//! Minimal PDF 1.4 writer built on `std` only. No third-party PDF libraries.
//!
//! Maintains an output buffer, an object offset table, and emits xref + trailer.

pub struct PdfWriter {
    pub out: Vec<u8>,
    offsets: Vec<usize>, // index = obj_id - 1
}

impl PdfWriter {
    pub fn new() -> Self {
        Self {
            out: Vec::new(),
            offsets: Vec::new(),
        }
    }

    pub fn alloc(&mut self, n: u32) -> u32 {
        let start = self.offsets.len() as u32 + 1;
        for _ in 0..n {
            self.offsets.push(0);
        }
        start
    }

    fn put(&mut self, s: &str) {
        self.out.extend_from_slice(s.as_bytes());
    }

    fn put_bytes(&mut self, b: &[u8]) {
        self.out.extend_from_slice(b);
    }

    pub fn header(&mut self) {
        self.put("%PDF-1.4\n");
        // binary comment to mark the file as binary
        self.out.extend_from_slice(&[b'%', 0xE2, 0xE3, 0xCF, 0xD3, b'\n']);
    }

    pub fn begin_obj(&mut self, id: u32) {
        let off = self.out.len();
        let idx = (id as usize) - 1;
        self.offsets[idx] = off;
        self.put(&format!("{} 0 obj\n", id));
    }

    pub fn end_obj(&mut self) {
        self.put("\nendobj\n");
    }

    /// Write an object whose body is an arbitrary dict/text (non-stream).
    pub fn indirect(&mut self, id: u32, body: &str) {
        self.begin_obj(id);
        self.put(body);
        self.put("\n");
        self.end_obj();
    }

    /// Write a stream object. `dict_extra` is inserted into the stream dict
    /// (e.g. `/Width 800`). /Length is added automatically.
    pub fn stream(&mut self, id: u32, dict_extra: &str, data: &[u8]) {
        self.begin_obj(id);
        self.put(&format!(
            "<< /Length {}{} >>\nstream\n",
            data.len(),
            dict_extra
        ));
        self.put_bytes(data);
        self.put("\nendstream");
        self.end_obj();
    }

    /// Finalize: write xref table + trailer. Returns startxref offset.
    pub fn finish(&mut self, root_id: u32) -> usize {
        let xref_offset = self.out.len();
        let count = self.offsets.len();
        self.put(&format!("xref\n0 {}\n", count + 1));
        self.put("0000000000 65535 f \n");
        let mut body = String::new();
        for off in &self.offsets {
            body.push_str(&format!("{:010} 00000 n \n", off));
        }
        self.put(&body);
        self.put(&format!(
            "trailer\n<< /Size {} /Root {} 0 R >>\nstartxref\n{}\n%%EOF\n",
            count + 1,
            root_id,
            xref_offset
        ));
        xref_offset
    }

    pub fn into_bytes(self) -> Vec<u8> {
        self.out
    }
}
