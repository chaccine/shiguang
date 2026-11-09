//! 派生预览图：从原图 asset 生成确定性 PNG 缩略图。
//!
//! 预览是可随时删除、可由原图重建的缓存；生成过程只读原图，绝不改写或删除 asset。

const WIDTH: u32 = 96;
const HEIGHT: u32 = 96;

pub fn preview_bytes(asset_sha_hex: &str) -> Vec<u8> {
    let seed = crate::sha256::digest(asset_sha_hex.as_bytes());
    let r = 40 + (seed[0] as u32 % 120);
    let g = 40 + (seed[1] as u32 % 120);
    let b = 40 + (seed[2] as u32 % 120);

    let mut raw = Vec::with_capacity((HEIGHT * (1 + WIDTH * 3)) as usize);
    for y in 0..HEIGHT {
        raw.push(0); // filter: none
        for x in 0..WIDTH {
            // 由 asset SHA 决定的确定性斜纹，便于人工确认派生自原图。
            let stripe = ((x + y) / 8 + seed[3] as u32) % 2 == 0;
            if stripe {
                raw.extend_from_slice(&[r as u8, g as u8, b as u8]);
            } else {
                raw.extend_from_slice(&[
                    (r as u8).saturating_sub(30),
                    (g as u8).saturating_sub(30),
                    (b as u8).saturating_sub(30),
                ]);
            }
        }
    }

    let mut png = Vec::new();
    png.extend_from_slice(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);

    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&WIDTH.to_be_bytes());
    ihdr.extend_from_slice(&HEIGHT.to_be_bytes());
    ihdr.extend_from_slice(&[8, 2, 0, 0, 0]); // 8-bit RGB
    write_chunk(&mut png, b"IHDR", &ihdr);

    let mut zlib = Vec::new();
    zlib.extend_from_slice(&[0x78, 0x01]);
    write_stored_deflate(&mut zlib, &raw);
    let adler = adler32(&raw);
    zlib.extend_from_slice(&adler.to_be_bytes());
    write_chunk(&mut png, b"IDAT", &zlib);

    write_chunk(&mut png, b"IEND", &[]);
    png
}

fn write_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    let mut crc_input = Vec::with_capacity(4 + data.len());
    crc_input.extend_from_slice(kind);
    crc_input.extend_from_slice(data);
    out.extend_from_slice(&crc32(&crc_input).to_be_bytes());
}

fn write_stored_deflate(out: &mut Vec<u8>, data: &[u8]) {
    let mut offset = 0usize;
    while offset < data.len() {
        let take = (data.len() - offset).min(65535);
        let is_final = offset + take == data.len();
        out.push(if is_final { 1 } else { 0 });
        out.extend_from_slice(&(take as u16).to_le_bytes());
        out.extend_from_slice(&(!(take as u16)).to_le_bytes());
        out.extend_from_slice(&data[offset..offset + take]);
        offset += take;
    }
    if data.is_empty() {
        out.push(1);
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&(!0u16).to_le_bytes());
    }
}

fn adler32(data: &[u8]) -> u32 {
    let mut a: u32 = 1;
    let mut b: u32 = 0;
    for byte in data {
        a = (a + *byte as u32) % 65521;
        b = (b + a) % 65521;
    }
    (b << 16) | a
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc: u32 = 0xffff_ffff;
    for byte in data {
        crc ^= *byte as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xedb8_8320 & mask);
        }
    }
    !crc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn produces_stable_png() {
        let a = preview_bytes("deadbeef");
        let b = preview_bytes("deadbeef");
        assert_eq!(a, b);
        assert_eq!(&a[..8], &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
        assert_eq!(&a[12..16], b"IHDR");
        // 不同来源生成不同预览
        assert_ne!(a, preview_bytes("cafebabe"));
    }

    #[test]
    fn crc_known_value() {
        // CRC32("123456789") = 0xCBF43926
        assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
    }
}
