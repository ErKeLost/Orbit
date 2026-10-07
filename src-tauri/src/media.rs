//! Media preview metadata for the file pane. The bytes themselves stream to
//! the webview through Tauri's asset protocol (`convertFileSrc`), so images,
//! audio and video never cross the IPC bridge as base64.

use serde::Serialize;
use std::path::{Path, PathBuf};

fn expand_home(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    if path == "~" {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home);
        }
    }
    PathBuf::from(path)
}

fn mime_for(name: &Path) -> Option<&'static str> {
    let ext = name.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "m4a" => "audio/mp4",
        "flac" => "audio/flac",
        "aac" => "audio/aac",
        "opus" => "audio/opus",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "pdf" => "application/pdf",
        _ => return None,
    })
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MediaMeta {
    pub mime: String,
    pub size: u64,
}

/// `None`-like error text for non-media files; the caller decides the view.
#[tauri::command]
pub async fn media_meta(path: String) -> Result<Option<MediaMeta>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file = expand_home(&path);
        let Some(mime) = mime_for(&file) else { return Ok(None) };
        let size = std::fs::metadata(&file).map_err(|e| e.to_string())?.len();
        Ok(Some(MediaMeta { mime: mime.into(), size }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniffs_common_media() {
        assert_eq!(mime_for(Path::new("a/hero.JPG")), Some("image/jpeg"));
        assert_eq!(mime_for(Path::new("x/avicii.mp3")), Some("audio/mpeg"));
        assert_eq!(mime_for(Path::new("x/clip.mp4")), Some("video/mp4"));
        assert_eq!(mime_for(Path::new("x/main.ts")), None);
    }
}
