//! Composer attachments: files on the clipboard, dragged images read as base64,
//! and generated images written back to a user-chosen path.
use serde_json::{json, Value};
use std::process::Command;

/// Absolute paths of files currently on the clipboard (Finder ⌘C → composer ⌘V).
/// Each platform reads its native pasteboard; an empty clipboard yields [].
#[tauri::command(async)]
pub fn clipboard_file_paths() -> Vec<String> {
    let (program, args) = if cfg!(target_os = "macos") {
        let script = "on run\n  set out to \"\"\n  try\n    set theItems to the clipboard as «class furl»\n    if class of theItems is list then\n      repeat with p in theItems\n        set out to out & POSIX path of p & linefeed\n      end repeat\n    else\n      set out to POSIX path of theItems & linefeed\n    end if\n  end try\n  return out\nend run";
        (
            "/usr/bin/osascript",
            vec!["-e".to_string(), script.to_string()],
        )
    } else if cfg!(target_os = "windows") {
        (
            "powershell",
            vec![
                "-NoProfile".to_string(),
                "-Command".to_string(),
                "Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }".to_string(),
            ],
        )
    } else {
        (
            "xclip",
            vec![
                "-o".to_string(),
                "-selection".to_string(),
                "clipboard".to_string(),
                "-t".to_string(),
                "text/uri-list".to_string(),
            ],
        )
    };
    let Ok(output) = Command::new(program).args(args).output() else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            let path = line.strip_prefix("file://").unwrap_or(line);
            let path = percent_decode(path);
            let trimmed = path.trim_start_matches("/ cyclical"); // no-op guard for odd xclip output
            if trimmed.starts_with('/') || trimmed.len() >= 2 && trimmed.as_bytes()[1] == b':' {
                Some(trimmed.to_string())
            } else {
                None
            }
        })
        .collect()
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3])
                .ok()
                .and_then(|value| u8::from_str_radix(value, 16).ok());
            if let Some(byte) = hex {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn mime_for_extension(extension: &str) -> Option<&'static str> {
    match extension {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        _ => None,
    }
}

/// Read a dragged file as a base64 image attachment. Returns an error for
/// non-image paths so the caller can attach them by path instead.
#[tauri::command(async)]
pub fn read_file_attachment(path: String) -> Result<Value, String> {
    let name = std::path::Path::new(&path)
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.clone());
    let extension = name.rsplit('.').next().unwrap_or("").to_lowercase();
    let Some(mime) = mime_for_extension(&extension) else {
        return Err(format!("not an image: {path}"));
    };
    let bytes = std::fs::read(&path).map_err(|e| format!("{}: {e}", path))?;
    use base64::Engine as _;
    let data = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(json!({ "name": name, "data": data, "mimeType": mime }))
}

/// Write an image payload (base64, or a full `data:` URL) to a user-chosen
/// path, so a generated image can be saved outside the media cache. Missing
/// parent directories are created; the returned path is what was written.
#[tauri::command(async)]
pub fn save_media_file(data: String, destination: String) -> Result<String, String> {
    let path = std::path::PathBuf::from(destination.trim());
    if path.file_name().is_none() {
        return Err(format!("无效的保存路径：{destination}"));
    }
    // Tolerate `data:image/jpeg;base64,...` as well as a bare base64 payload.
    let payload = data.rsplit(',').next().unwrap_or(&data);
    let compact: String = payload.chars().filter(|value| !value.is_whitespace()).collect();
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(compact.as_bytes())
        .map_err(|e| format!("图片数据无法解码：{e}"))?;
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建目录 {} 失败：{e}", parent.display()))?;
        }
    }
    std::fs::write(&path, bytes).map_err(|e| format!("写入 {} 失败：{e}", path.display()))?;
    Ok(path.to_string_lossy().into_owned())
}
