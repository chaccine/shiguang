//! Bounded real image decoding, outside the domain core. Originals are read-only.
use std::{io::Cursor, path::Path};

fn portable(source: &Path, target: &Path) -> Result<(), String> {
    if std::fs::metadata(source).map_err(|e| e.to_string())?.len() > 128 * 1024 * 1024 {
        return Err("source exceeds decode budget".into());
    }
    let mut reader = image::ImageReader::open(source)
        .map_err(|e| e.to_string())?
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(128 * 1024 * 1024);
    limits.max_image_width = Some(32000);
    limits.max_image_height = Some(32000);
    reader.limits(limits);
    let decoded = reader.decode().map_err(|e| e.to_string())?;
    let thumb = decoded.thumbnail(320, 320);
    let mut bytes = Cursor::new(Vec::new());
    thumb
        .write_to(&mut bytes, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    std::fs::create_dir_all(target.parent().ok_or("missing cache directory")?)
        .map_err(|e| e.to_string())?;
    // Same-directory temporary file; callers serialize writes under their store mutex.
    let temporary = target.with_extension("tmp");
    std::fs::write(&temporary, bytes.into_inner()).map_err(|e| e.to_string())?;
    std::fs::rename(&temporary, target).map_err(|e| e.to_string())
}

pub fn generate(source: &Path, target: &Path) -> Result<(), String> {
    portable(source, target).or_else(|error| {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            native(source, target).map_err(|e| format!("{error}; {e}"))
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            Err(error)
        }
    })
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn native(source: &Path, target: &Path) -> Result<(), String> {
    use std::{
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    std::fs::create_dir_all(target.parent().ok_or("missing cache directory")?)
        .map_err(|e| e.to_string())?;
    let temporary = target.with_extension("native.png");
    #[cfg(target_os = "macos")]
    let mut command = {
        // sips uses the system ImageIO codecs, including HEIF where supported.
        let mut c = Command::new("/usr/bin/sips");
        c.args(["-s", "format", "png", "-Z", "320"])
            .arg(source)
            .arg("--out")
            .arg(&temporary);
        c
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        // WPF BitmapDecoder delegates to WIC. HEIF extension may not be installed.
        let mut c = Command::new("powershell.exe");
        c.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            r#"
$ErrorActionPreference='Stop'
Add-Type -AssemblyName PresentationCore
$b=New-Object Windows.Media.Imaging.BitmapImage
$b.BeginInit(); $b.CacheOption=[Windows.Media.Imaging.BitmapCacheOption]::OnLoad
$b.DecodePixelWidth=320; $b.UriSource=New-Object Uri($env:SHIGUANG_THUMB_SOURCE); $b.EndInit()
$e=New-Object Windows.Media.Imaging.PngBitmapEncoder
$e.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($b))
$f=[IO.File]::Create($env:SHIGUANG_THUMB_TARGET)
try {$e.Save($f)} finally {$f.Dispose()}
"#,
        ])
        .env("SHIGUANG_THUMB_SOURCE", source)
        .env("SHIGUANG_THUMB_TARGET", &temporary);
        c
    };
    let mut child = command
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    let start = Instant::now();
    let result = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status.success();
        }
        if start.elapsed() > Duration::from_secs(15) {
            let _ = child.kill();
            let _ = child.wait();
            break false;
        }
        std::thread::sleep(Duration::from_millis(30));
    };
    if !result {
        let _ = std::fs::remove_file(&temporary);
        return Err("native codec unavailable or timed out".into());
    }
    // Verify native output and bound both dimensions before using it as a cache.
    let result = portable(&temporary, target);
    let _ = std::fs::remove_file(&temporary);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn real_formats_decode_to_small_stable_cache_and_preserve_original() {
        let root = std::env::temp_dir().join(format!("sg-thumb-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let mut store = shiguang_core::Store::open(root.join("store")).unwrap();
        let id = store
            .create_draft(None, "合成缩略图测试", "正文", "2026-11-11", None)
            .unwrap()
            .record_id;
        for (extension, format) in [
            ("png", image::ImageFormat::Png),
            ("jpg", image::ImageFormat::Jpeg),
            ("gif", image::ImageFormat::Gif),
            ("webp", image::ImageFormat::WebP),
        ] {
            let source = root.join(format!("synthetic.{extension}"));
            let target = root.join(format!("{extension}.thumb.png"));
            let img = image::RgbImage::from_fn(1600, 1200, |x, y| {
                image::Rgb([(x % 251) as u8, (y % 241) as u8, ((x + y) % 239) as u8])
            });
            image::DynamicImage::ImageRgb8(img)
                .save_with_format(&source, format)
                .unwrap();
            let original = std::fs::read(&source).unwrap();
            let photo = store.attach_photo(&id, &source, "合成图片", None).unwrap();
            let created = store
                .ensure_previews_with(|source, target| {
                    generate(source, target)
                        .map_err(|e| shiguang_core::CoreError::new("PREVIEW_UNSUPPORTED", e))
                })
                .unwrap();
            assert!(created.contains(&photo.asset_id));
            let cache = store.preview_path(&photo.asset_id);
            let cached = std::fs::read(&cache).unwrap();
            let decoded_cache = image::open(&cache).unwrap();
            assert!(decoded_cache.width() <= 320 && decoded_cache.height() <= 320);
            // 有损 WebP 把合成花纹压得很小，可能小于 320px PNG 预览；尺寸上限才是硬约束。
            assert!(
                cached.len() < original.len() || original.len() < 64 * 1024,
                "{extension} original={} cached={}",
                original.len(),
                cached.len()
            );
            assert!(store
                .ensure_previews_with(|_, _| panic!("existing previews must not decode again"))
                .unwrap()
                .is_empty());
            store.clear_previews().unwrap();
            assert!(!cache.exists());
            assert_eq!(
                std::fs::read(store.asset_path(&photo.asset_id).unwrap()).unwrap(),
                original
            );
            store
                .ensure_previews_with(|source, target| {
                    generate(source, target)
                        .map_err(|e| shiguang_core::CoreError::new("PREVIEW_UNSUPPORTED", e))
                })
                .unwrap();
            assert_eq!(std::fs::read(cache).unwrap(), cached);
            generate(&source, &target).unwrap();
            let first = std::fs::read(&target).unwrap();
            let decoded_first = image::open(&target).unwrap();
            assert!(decoded_first.width() <= 320 && decoded_first.height() <= 320);
            assert!(first.len() < original.len() || original.len() < 64 * 1024);
            let decoded = image::open(&target).unwrap();
            assert!(decoded.width() <= 320 && decoded.height() <= 320);
            std::fs::remove_file(&target).unwrap();
            generate(&source, &target).unwrap();
            assert_eq!(std::fs::read(&target).unwrap(), first);
            assert_eq!(std::fs::read(&source).unwrap(), original);
        }
        let bad = root.join("bad.heic");
        std::fs::write(&bad, b"not a decodable HEIC").unwrap();
        assert!(generate(&bad, &root.join("bad.png")).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
