const PADDING: [u8; 32] = [
    0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41,
    0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08,
    0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80,
    0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A,
];

#[derive(Clone, Debug)]
pub struct EncryptionConfig {
    pub permissions_mask: u8,
    pub user_password: Vec<u8>,
    pub owner_password: Vec<u8>,
    pub file_id: [u8; 16],
}

#[derive(Clone, Debug)]
pub struct PdfSecurity {
    pub file_id: [u8; 16],
    pub o: Vec<u8>,
    pub p: i32,
    pub u: Vec<u8>,
    encryption_key: Vec<u8>,
}

pub fn parse_config(bytes: &[u8]) -> Result<EncryptionConfig, String> {
    if bytes.len() < 22 {
        return Err("encryption config too short".into());
    }
    let version = bytes[0];
    if version != 1 {
        return Err(format!("unsupported encryption config version {}", version));
    }
    let permissions_mask = bytes[1];
    let user_len = u16::from_le_bytes([bytes[2], bytes[3]]) as usize;
    let owner_len = u16::from_le_bytes([bytes[4], bytes[5]]) as usize;
    let expected = 22 + user_len + owner_len;
    if bytes.len() != expected {
        return Err("invalid encryption config length".into());
    }
    let mut file_id = [0u8; 16];
    file_id.copy_from_slice(&bytes[6..22]);
    let user_start = 22;
    let owner_start = user_start + user_len;
    Ok(EncryptionConfig {
        permissions_mask,
        user_password: bytes[user_start..owner_start].to_vec(),
        owner_password: bytes[owner_start..owner_start + owner_len].to_vec(),
        file_id,
    })
}

impl PdfSecurity {
    pub fn new(config: &EncryptionConfig) -> Self {
        let padded_user = pad_password(&config.user_password);
        let padded_owner = pad_password(&config.owner_password);
        let owner_key = &md5(&padded_owner)[..5];
        let o = rc4(owner_key, &padded_user);

        let mut protection = 192u32;
        if config.permissions_mask & (1 << 0) != 0 {
            protection += 4; // print
        }
        if config.permissions_mask & (1 << 1) != 0 {
            protection += 8; // modify
        }
        if config.permissions_mask & (1 << 2) != 0 {
            protection += 16; // copy
        }
        if config.permissions_mask & (1 << 3) != 0 {
            protection += 32; // annot-forms
        }
        let p = -(((protection ^ 255) as i32) + 1);

        let mut key_material = Vec::with_capacity(32 + o.len() + 4 + 16);
        key_material.extend_from_slice(&padded_user);
        key_material.extend_from_slice(&o);
        key_material.extend_from_slice(&p.to_le_bytes());
        key_material.extend_from_slice(&config.file_id);
        let encryption_key = md5(&key_material)[..5].to_vec();
        let u = rc4(&encryption_key, &PADDING);

        Self {
            file_id: config.file_id,
            o,
            p,
            u,
            encryption_key,
        }
    }

    pub fn encrypt_bytes(&self, object_id: u32, generation: u16, data: &[u8]) -> Vec<u8> {
        let mut key_material = Vec::with_capacity(self.encryption_key.len() + 5);
        key_material.extend_from_slice(&self.encryption_key);
        key_material.push((object_id & 0xff) as u8);
        key_material.push(((object_id >> 8) & 0xff) as u8);
        key_material.push(((object_id >> 16) & 0xff) as u8);
        key_material.push((generation & 0xff) as u8);
        key_material.push(((generation >> 8) & 0xff) as u8);
        let digest = md5(&key_material);
        let key_len = (self.encryption_key.len() + 5).min(16);
        rc4(&digest[..key_len], data)
    }

    pub fn encrypt_dict(&self) -> String {
        format!(
            "<< /Filter /Standard /V 1 /R 2 /O <{}> /U <{}> /P {} >>",
            to_hex(&self.o),
            to_hex(&self.u),
            self.p
        )
    }
}

fn pad_password(password: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let copy_len = password.len().min(32);
    out[..copy_len].copy_from_slice(&password[..copy_len]);
    if copy_len < 32 {
        out[copy_len..].copy_from_slice(&PADDING[..32 - copy_len]);
    }
    out
}

fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        s.push_str(&format!("{:02X}", byte));
    }
    s
}

fn rc4(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut s = [0u8; 256];
    for (i, item) in s.iter_mut().enumerate() {
        *item = i as u8;
    }
    let mut j = 0usize;
    for i in 0..256usize {
        j = (j + s[i] as usize + key[i % key.len()] as usize) & 0xff;
        s.swap(i, j);
    }
    let mut i = 0usize;
    j = 0;
    let mut out = Vec::with_capacity(data.len());
    for byte in data {
        i = (i + 1) & 0xff;
        j = (j + s[i] as usize) & 0xff;
        s.swap(i, j);
        let idx = (s[i] as usize + s[j] as usize) & 0xff;
        out.push(byte ^ s[idx]);
    }
    out
}

fn md5(input: &[u8]) -> [u8; 16] {
    let mut msg = input.to_vec();
    let bit_len = (msg.len() as u64) * 8;
    msg.push(0x80);
    while (msg.len() % 64) != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_le_bytes());

    let mut a0: u32 = 0x67452301;
    let mut b0: u32 = 0xEFCDAB89;
    let mut c0: u32 = 0x98BADCFE;
    let mut d0: u32 = 0x10325476;

    const S: [u32; 64] = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
        5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
        4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
        6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
    ];

    const K: [u32; 64] = [
        0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee,
        0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
        0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
        0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
        0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa,
        0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
        0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
        0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
        0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
        0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
        0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05,
        0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
        0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039,
        0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
        0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
        0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
    ];

    for chunk in msg.chunks_exact(64) {
        let mut m = [0u32; 16];
        for (i, word) in m.iter_mut().enumerate() {
            let base = i * 4;
            *word = u32::from_le_bytes([
                chunk[base],
                chunk[base + 1],
                chunk[base + 2],
                chunk[base + 3],
            ]);
        }

        let mut a = a0;
        let mut b = b0;
        let mut c = c0;
        let mut d = d0;

        for i in 0..64usize {
            let (f, g) = if i < 16 {
                ((b & c) | ((!b) & d), i)
            } else if i < 32 {
                ((d & b) | ((!d) & c), (5 * i + 1) % 16)
            } else if i < 48 {
                (b ^ c ^ d, (3 * i + 5) % 16)
            } else {
                (c ^ (b | (!d)), (7 * i) % 16)
            };
            let tmp = d;
            d = c;
            c = b;
            b = b.wrapping_add(
                a.wrapping_add(f)
                    .wrapping_add(K[i])
                    .wrapping_add(m[g])
                    .rotate_left(S[i]),
            );
            a = tmp;
        }

        a0 = a0.wrapping_add(a);
        b0 = b0.wrapping_add(b);
        c0 = c0.wrapping_add(c);
        d0 = d0.wrapping_add(d);
    }

    let mut out = [0u8; 16];
    out[..4].copy_from_slice(&a0.to_le_bytes());
    out[4..8].copy_from_slice(&b0.to_le_bytes());
    out[8..12].copy_from_slice(&c0.to_le_bytes());
    out[12..16].copy_from_slice(&d0.to_le_bytes());
    out
}
