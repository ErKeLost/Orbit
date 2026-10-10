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

/// The largest file a phone will pull over the pairing socket.
///
/// `read_media_file` answers with base64, so the string on the wire is a third
/// larger than the file and lives in the webview's memory until the blob is
/// built. This is the ceiling that keeps a phone from being asked to hold a
/// video; past it the command fails with a message that says so, which is a
/// better answer than a preview that never appears. The desktop is unaffected:
/// it streams through the asset protocol and has no such limit.
pub const MAX_REMOTE_MEDIA_BYTES: u64 = 24 * 1024 * 1024;

/// Whether a file is too large to send to a phone.
///
/// Split out so the boundary is testable without a 24 MB fixture on disk.
fn over_remote_media_limit(size: u64) -> bool {
    size > MAX_REMOTE_MEDIA_BYTES
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MediaBytes {
    pub mime: String,
    /// base64 of the file's bytes. The phone decodes it into a `Blob` and hands
    /// the object URL to the same `<img>`/`<video>` markup the desktop uses.
    pub data: String,
}

/// `media_meta`'s counterpart for a device that cannot reach this disk.
///
/// The desktop webview streams media through the asset protocol, which is "this
/// webview reads this machine's disk" and therefore means nothing on a phone. A
/// paired phone asks for the bytes here instead, over the socket it already has.
#[tauri::command]
pub async fn read_media_file(path: String) -> Result<MediaBytes, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file = expand_home(&path);
        let mime = mime_for(&file).ok_or_else(|| "不是可预览的媒体文件".to_string())?;
        let size = std::fs::metadata(&file).map_err(|e| e.to_string())?.len();
        if over_remote_media_limit(size) {
            return Err(format!(
                "文件 {:.1} MB，超过手机预览上限 {} MB；请在电脑上查看",
                size as f64 / (1024.0 * 1024.0),
                MAX_REMOTE_MEDIA_BYTES / (1024 * 1024)
            ));
        }
        let bytes = std::fs::read(&file).map_err(|e| e.to_string())?;
        Ok(MediaBytes {
            mime: mime.into(),
            data: base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes),
        })
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

    #[test]
    fn the_phone_limit_is_inclusive_at_the_ceiling() {
        assert!(!over_remote_media_limit(MAX_REMOTE_MEDIA_BYTES));
        assert!(!over_remote_media_limit(0));
        assert!(over_remote_media_limit(MAX_REMOTE_MEDIA_BYTES + 1));
    }
}
