use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use rand::RngCore;

const MAX_IMAGE_BYTES: usize = 24 * 1024 * 1024;

fn image_extension(mime: &str) -> Option<&'static str> {
    match mime.to_ascii_lowercase().as_str() {
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        "image/heic" => Some("heic"),
        "image/heif" => Some("heif"),
        "image/avif" => Some("avif"),
        "image/bmp" => Some("bmp"),
        "image/tiff" => Some("tiff"),
        _ => None,
    }
}

pub(super) fn persist_inline_images(
    directory: &Path,
    image_urls: &[String],
) -> io::Result<Vec<PathBuf>> {
    let mut persisted = Vec::new();
    for image_url in image_urls {
        let Some(data_url) = image_url.strip_prefix("data:") else { continue; };
        let (header, encoded) = data_url.split_once(',').ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "Malformed image attachment")
        })?;
        let Some(mime) = header.strip_suffix(";base64") else { continue; };
        let Some(extension) = image_extension(mime) else { continue; };
        let bytes = STANDARD.decode(encoded).map_err(|error| {
            io::Error::new(io::ErrorKind::InvalidInput, format!("Invalid image attachment: {error}"))
        })?;
        if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "Image attachment must be between 1 byte and 24 MB"));
        }
        fs::create_dir_all(directory)?;

        let mut random = [0_u8; 16];
        rand::rng().fill_bytes(&mut random);
        let filename = format!("attachment-{}.{}", random.iter().map(|byte| format!("{byte:02x}")).collect::<String>(), extension);
        let path = directory.join(filename);
        let mut file = OpenOptions::new().write(true).create_new(true).open(&path)?;
        file.write_all(&bytes)?;
        persisted.push(path);
    }
    Ok(persisted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn saves_inline_image_as_a_local_file_and_skips_remote_urls() {
        let directory = std::env::temp_dir().join(format!(
            "codex-board-attachments-{}",
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        let paths = persist_inline_images(
            &directory,
            &[
                "data:image/png;base64,aGVsbG8=".into(),
                "https://example.test/image.png".into(),
            ],
        ).unwrap();

        assert_eq!(paths.len(), 1);
        assert_eq!(paths[0].extension().and_then(|extension| extension.to_str()), Some("png"));
        assert_eq!(fs::read(&paths[0]).unwrap(), b"hello");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rejects_malformed_or_oversized_inline_images() {
        let directory = std::env::temp_dir().join(format!(
            "codex-board-attachments-invalid-{}",
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        assert!(persist_inline_images(&directory, &["data:image/png;base64,not base64".into()]).is_err());
        assert!(!directory.exists());
    }
}
