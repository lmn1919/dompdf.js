//! Minimal PDF 1.4 writer built on `std` only. No third-party PDF libraries.
//!
//! Maintains an output buffer, an object offset table, and emits xref + trailer.

use crate::encrypt::PdfSecurity;

pub struct PdfWriter {
    pub out: Vec<u8>,
    offsets: Vec<usize>, // index = obj_id - 1
    file_id: Option<[u8; 16]>,
    security: Option<PdfSecurity>,
    encrypt_id: Option<u32>,
}

impl PdfWriter {
    pub fn new() -> Self {
        Self {
            out: Vec::new(),
            offsets: Vec::new(),
            file_id: None,
            security: None,
            encrypt_id: None,
        }
    }

    pub fn with_security(security: PdfSecurity) -> Self {
        Self {
            file_id: Some(security.file_id),
            security: Some(security),
            encrypt_id: None,
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

    pub fn reserve_encrypt_obj(&mut self) -> u32 {
        let id = self.alloc(1);
        self.encrypt_id = Some(id);
        id
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

    pub fn write_encrypt_obj(&mut self) {
        if let (Some(security), Some(id)) = (self.security.as_ref(), self.encrypt_id) {
            let body = security.encrypt_dict();
            self.indirect(id, &body);
        }
    }

    /// Write a stream object. `dict_extra` is inserted into the stream dict
    /// (e.g. `/Width 800`). /Length is added automatically.
    pub fn stream(&mut self, id: u32, dict_extra: &str, data: &[u8]) {
        self.begin_obj(id);
        let payload = if let Some(security) = &self.security {
            if Some(id) == self.encrypt_id {
                data.to_vec()
            } else {
                security.encrypt_bytes(id, 0, data)
            }
        } else {
            data.to_vec()
        };
        self.put(&format!(
            "<< /Length {}{} >>\nstream\n",
            payload.len(),
            dict_extra
        ));
        self.put_bytes(&payload);
        self.put("\nendstream");
        self.end_obj();
    }

    /// Write a stream object compressed with FlateDecode. The caller supplies
    /// the compressed bytes and must ensure `dict_extra` does NOT contain
    /// /Filter or /Length (this method adds /Filter /FlateDecode and /Length).
    pub fn stream_compressed(&mut self, id: u32, dict_extra: &str, compressed: &[u8]) {
        self.begin_obj(id);
        let payload = if let Some(security) = &self.security {
            if Some(id) == self.encrypt_id {
                compressed.to_vec()
            } else {
                security.encrypt_bytes(id, 0, compressed)
            }
        } else {
            compressed.to_vec()
        };
        self.put(&format!(
            "<< /Length {} /Filter /FlateDecode{} >>\nstream\n",
            payload.len(),
            dict_extra
        ));
        self.put_bytes(&payload);
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
        self.put("trailer\n<< ");
        self.put(&format!("/Size {} /Root {} 0 R ", count + 1, root_id));
        if let Some(encrypt_id) = self.encrypt_id {
            self.put(&format!("/Encrypt {} 0 R ", encrypt_id));
        }
        if let Some(file_id) = self.file_id {
            let hex = file_id.iter().map(|b| format!("{:02X}", b)).collect::<String>();
            self.put(&format!("/ID [<{}> <{}>] ", hex, hex));
        }
        self.put(&format!(">>\nstartxref\n{}\n%%EOF\n", xref_offset));
        xref_offset
    }

    pub fn into_bytes(self) -> Vec<u8> {
        self.out
    }
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

/// Wrap `data` in a zlib stream using only *stored* (uncompressed) deflate
/// blocks. The result is a valid `/FlateDecode` stream with no actual
/// compression — used to embed lossless raw-RGB images without pulling in a
/// real deflate implementation (the crate is pure-std, no third-party libs).
pub fn zlib_store(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + data.len() / 0xFFFF * 5 + 16);
    // zlib header: CMF=0x78 (deflate, 32K window), FLG=0x01 (no preset dict,
    // fastest level). 0x7801 % 31 == 0, so the FCHECK bits are valid.
    out.push(0x78);
    out.push(0x01);
    if data.is_empty() {
        out.push(0x01); // BFINAL=1, BTYPE=00 (stored)
        out.extend_from_slice(&[0x00, 0x00, 0xFF, 0xFF]); // LEN=0, NLEN=~0
    } else {
        let mut i = 0usize;
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
    }
    out.extend_from_slice(&adler32(data).to_be_bytes());
    out
}
