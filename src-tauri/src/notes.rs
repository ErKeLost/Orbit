//! Notes: a small markdown notebook stored beside the app's data. One JSON
//! document per note under `app_data/notes`, image assets under
//! `app_data/note-assets/<note id>`. The command surface and data model match
//! the Orbit notes feature so the UI code is shared verbatim.

use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const TITLE_MAX: usize = 200;
const BODY_MAX: usize = 1_000_000;
const TAG_MAX: usize = 48;
const TAGS_MAX: usize = 20;
const IMAGE_MAX_BYTES: u64 = 20 * 1024 * 1024;
const IMAGE_EXTENSIONS: [&str; 6] = ["png", "jpg", "jpeg", "gif", "webp", "svg"];
const NOTE_ASSET_DIR: &str = "note-assets";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub slug: String,
    pub title: String,
    pub body: String,
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_cwd: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteUpsert {
    pub id: String,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub source_session_id: Option<String>,
    #[serde(default)]
    pub source_cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteImageAsset {
    pub name: String,
    pub markdown_path: String,
}

fn validate_id(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(format!("Invalid {label} id"));
    }
    Ok(())
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn dirs_home() -> Option<String> {
    std::env::var("HOME").ok().filter(|value| !value.is_empty())
}

fn expand_home(path: &str) -> PathBuf {
    if path == "~" {
        return dirs_home()
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(path));
    }
    let rest = path.strip_prefix("~/").or_else(|| {
        if cfg!(windows) {
            path.strip_prefix("~\\")
        } else {
            None
        }
    });
    if let Some(rest) = rest {
        if let Some(home) = dirs_home() {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(path)
}

fn notes_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("notes");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn note_file(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.json"))
}

fn read_note_file(path: &Path) -> Option<Note> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_note_file(dir: &Path, note: &Note) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(note).map_err(|e| e.to_string())?;
    let path = note_file(dir, &note.id);
    let tmp = dir.join(format!("{}.tmp", note.id));
    std::fs::write(&tmp, raw).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn all_notes(dir: &Path) -> Vec<Note> {
    let mut notes = Vec::new();
    let Ok(read) = std::fs::read_dir(dir) else {
        return notes;
    };
    for entry in read.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        if let Some(note) = read_note_file(&path) {
            notes.push(note);
        }
    }
    notes.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(a.id.cmp(&b.id)));
    notes
}

fn stored_note(dir: &Path, id: &str) -> Option<Note> {
    read_note_file(&note_file(dir, id))
}

#[tauri::command(async)]
pub fn notes_list(app: AppHandle) -> Result<Vec<Note>, String> {
    let dir = notes_dir(&app)?;
    Ok(all_notes(&dir))
}

#[tauri::command(async)]
pub fn notes_get(app: AppHandle, id: String) -> Result<Option<Note>, String> {
    validate_id(&id, "note")?;
    let dir = notes_dir(&app)?;
    Ok(stored_note(&dir, &id))
}

#[tauri::command(async)]
pub fn notes_upsert(app: AppHandle, note: NoteUpsert) -> Result<Note, String> {
    validate_id(&note.id, "note")?;
    if let Some(session_id) = note.source_session_id.as_deref() {
        if !session_id.is_empty() {
            validate_id(session_id, "session")?;
        }
    }
    if note.body.len() > BODY_MAX {
        return Err("Note is too large".into());
    }
    let dir = notes_dir(&app)?;
    upsert_note(&dir, &note)
}

#[tauri::command(async)]
pub fn notes_delete(app: AppHandle, id: String) -> Result<(), String> {
    validate_id(&id, "note")?;
    let dir = notes_dir(&app)?;
    let path = note_file(&dir, &id);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }?;
    // The note deletion is authoritative. A cleanup failure should not leave a
    // successfully deleted note visible in the UI.
    let _ = remove_note_assets(&app, &id);
    Ok(())
}

#[tauri::command]
pub async fn notes_save_image(
    app: AppHandle,
    note_id: String,
    source_path: String,
) -> Result<NoteImageAsset, String> {
    tauri::async_runtime::spawn_blocking(move || save_note_image_sync(&app, &note_id, &source_path))
        .await
        .map_err(|e| e.to_string())?
}

/// Save image bytes straight from a webview `File` (no temporary file round-trip).
#[tauri::command]
pub async fn notes_save_image_data(
    app: AppHandle,
    note_id: String,
    name: String,
    data: Vec<u8>,
) -> Result<NoteImageAsset, String> {
    tauri::async_runtime::spawn_blocking(move || {
        save_note_image_data_sync(&app, &note_id, &name, &data)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command(async)]
pub fn notes_image_path(app: AppHandle, asset: String) -> Result<String, String> {
    let relative = validate_note_asset_path(&asset)?;
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(relative);
    if !path.is_file() {
        return Err("Note image was not found".into());
    }
    Ok(path.to_string_lossy().into_owned())
}

fn note_assets_dir(app: &AppHandle, note_id: &str) -> Result<PathBuf, String> {
    validate_id(note_id, "note")?;
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(NOTE_ASSET_DIR)
        .join(note_id))
}

fn save_note_image_sync(
    app: &AppHandle,
    note_id: &str,
    source_path: &str,
) -> Result<NoteImageAsset, String> {
    let source = expand_home(source_path);
    let meta = std::fs::metadata(&source).map_err(|e| format!("{}: {e}", source.display()))?;
    if !meta.is_file() {
        return Err("Not a file".into());
    }
    if meta.len() > IMAGE_MAX_BYTES {
        return Err(format!(
            "Image is too large (maximum {} MB).",
            IMAGE_MAX_BYTES / 1024 / 1024
        ));
    }

    let (display_name, safe_name) = note_image_names(&source)?;
    let dir = note_assets_dir(app, note_id)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let stored_name = format!("{stamp}-{safe_name}");
    let destination = dir.join(&stored_name);
    std::fs::copy(&source, &destination).map_err(|e| format!("{}: {e}", destination.display()))?;

    Ok(NoteImageAsset {
        name: display_name,
        markdown_path: format!("/{NOTE_ASSET_DIR}/{note_id}/{stored_name}"),
    })
}

fn save_note_image_data_sync(
    app: &AppHandle,
    note_id: &str,
    display_name: &str,
    data: &[u8],
) -> Result<NoteImageAsset, String> {
    if data.len() as u64 > IMAGE_MAX_BYTES {
        return Err(format!(
            "Image is too large (maximum {} MB).",
            IMAGE_MAX_BYTES / 1024 / 1024
        ));
    }
    let extension = Path::new(display_name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !IMAGE_EXTENSIONS.contains(&extension.as_str()) {
        return Err("Image must be a PNG, JPG, GIF, WebP, or SVG file.".into());
    }
    let stem = Path::new(display_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("image");
    let mut safe_stem: String = stem
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .take(80)
        .collect();
    safe_stem = safe_stem.trim_matches('-').to_string();
    if safe_stem.is_empty() {
        safe_stem = "image".into();
    }

    let dir = note_assets_dir(app, note_id)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let stored_name = format!("{stamp}-{safe_stem}.{extension}");
    let destination = dir.join(&stored_name);
    std::fs::write(&destination, data).map_err(|e| format!("{}: {e}", destination.display()))?;

    Ok(NoteImageAsset {
        name: display_name.to_string(),
        markdown_path: format!("/{NOTE_ASSET_DIR}/{note_id}/{stored_name}"),
    })
}

fn note_image_names(source: &Path) -> Result<(String, String), String> {
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !IMAGE_EXTENSIONS.contains(&extension.as_str()) {
        return Err("Image must be a PNG, JPG, GIF, WebP, or SVG file.".into());
    }
    let display_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("image")
        .to_string();
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("image");
    let mut safe_stem: String = stem
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .take(80)
        .collect();
    safe_stem = safe_stem.trim_matches('-').to_string();
    if safe_stem.is_empty() {
        safe_stem = "image".into();
    }
    Ok((display_name, format!("{safe_stem}.{extension}")))
}

fn validate_note_asset_path(asset: &str) -> Result<PathBuf, String> {
    let relative = asset
        .strip_prefix('/')
        .ok_or_else(|| "Invalid note image path".to_string())?;
    let path = Path::new(relative);
    let parts = path
        .components()
        .map(|part| match part {
            Component::Normal(value) => value.to_str().map(str::to_string),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| "Invalid note image path".to_string())?;
    if parts.len() != 3 || parts[0] != NOTE_ASSET_DIR {
        return Err("Invalid note image path".into());
    }
    validate_id(&parts[1], "note")?;
    if parts[2].is_empty()
        || !parts[2]
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err("Invalid note image path".into());
    }
    Ok(path.to_path_buf())
}

fn remove_note_assets(app: &AppHandle, note_id: &str) -> Result<(), String> {
    let dir = note_assets_dir(app, note_id)?;
    match std::fs::remove_dir_all(dir) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn upsert_note(dir: &Path, note: &NoteUpsert) -> Result<Note, String> {
    let title = normalize_title(&note.title);
    let body = note.body.replace("\r\n", "\n").replace('\r', "\n");
    let tags = normalize_tags(&note.tags);
    let source_session_id = note
        .source_session_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let source_cwd = note
        .source_cwd
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let now = now_millis();

    if let Some(existing) = stored_note(dir, &note.id) {
        let project_cwd = source_cwd.map(str::to_string).or(existing.source_cwd);
        // Project changes keep the note in its current position in the list.
        let updated_at =
            if title == existing.title && body == existing.body && tags == existing.tags {
                existing.updated_at
            } else {
                now
            };
        let updated = Note {
            id: note.id.clone(),
            slug: existing.slug,
            title,
            body,
            tags,
            source_session_id: existing.source_session_id,
            source_cwd: project_cwd,
            created_at: existing.created_at,
            updated_at,
        };
        write_note_file(dir, &updated)?;
        Ok(updated)
    } else {
        let slug = unique_slug(dir, &title)?;
        let created = Note {
            id: note.id.clone(),
            slug,
            title,
            body,
            tags,
            source_session_id: source_session_id.map(str::to_string),
            source_cwd: source_cwd.map(str::to_string),
            created_at: now,
            updated_at: now,
        };
        write_note_file(dir, &created)?;
        Ok(created)
    }
}

fn normalize_tags(tags: &[String]) -> Vec<String> {
    let mut normalized = Vec::new();
    for input in tags {
        let tag = input
            .trim()
            .trim_start_matches('#')
            .split_whitespace()
            .collect::<Vec<_>>()
            .join("-")
            .to_lowercase();
        let tag: String = tag.chars().take(TAG_MAX).collect();
        let tag = tag.trim_end_matches('-').to_string();
        if tag.is_empty() || normalized.contains(&tag) {
            continue;
        }
        normalized.push(tag);
        if normalized.len() == TAGS_MAX {
            break;
        }
    }
    normalized
}

fn normalize_title(title: &str) -> String {
    let trimmed = title.trim();
    let sliced: String = trimmed.chars().take(TITLE_MAX).collect();
    let sliced = sliced.trim().to_string();
    if sliced.is_empty() {
        "Untitled".into()
    } else {
        sliced
    }
}

fn slugify(title: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for ch in title.chars() {
        let c = ch.to_ascii_lowercase();
        if c.is_ascii_alphanumeric() {
            out.push(c);
            dash = false;
        } else if !out.is_empty() && !dash {
            out.push('-');
            dash = true;
        }
        if out.len() >= 48 {
            break;
        }
    }
    let slug = out.trim_end_matches('-').to_string();
    if slug.is_empty() {
        "note".into()
    } else {
        slug
    }
}

fn unique_slug(dir: &Path, title: &str) -> Result<String, String> {
    let base = slugify(title);
    let taken: std::collections::HashSet<String> = all_notes(dir)
        .iter()
        .map(|note| note.slug.clone())
        .collect();
    for index in 0..1000 {
        let candidate = if index == 0 {
            base.clone()
        } else {
            format!("{base}-{}", index + 1)
        };
        if !taken.contains(&candidate) {
            return Ok(candidate);
        }
    }
    Ok(format!("{base}-{}", now_millis()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn upsert(dir: &Path, id: &str, title: &str, body: &str) -> Note {
        upsert_note(
            dir,
            &NoteUpsert {
                id: id.into(),
                title: title.into(),
                body: body.into(),
                tags: Vec::new(),
                source_session_id: None,
                source_cwd: None,
            },
        )
        .unwrap()
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("orbit-notes-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn insert_update_and_list_newest_first() {
        let dir = temp_dir("order");
        let first = upsert(&dir, "n1", "Alpha", "one");
        std::thread::sleep(std::time::Duration::from_millis(5));
        let second = upsert(&dir, "n2", "Beta", "two");
        assert_eq!(first.slug, "alpha");
        assert_eq!(second.slug, "beta");

        let listed = all_notes(&dir);
        assert_eq!(
            listed
                .iter()
                .map(|note| note.id.as_str())
                .collect::<Vec<_>>(),
            vec!["n2", "n1"]
        );

        std::thread::sleep(std::time::Duration::from_millis(5));
        let updated = upsert_note(
            &dir,
            &NoteUpsert {
                id: "n1".into(),
                title: "Alpha renamed".into(),
                body: "changed".into(),
                tags: vec!["Ideas".into(), "project docs".into(), "ideas".into()],
                source_session_id: Some("sess-1".into()),
                source_cwd: Some("/tmp/a".into()),
            },
        )
        .unwrap();
        assert_eq!(updated.slug, "alpha");
        assert_eq!(updated.title, "Alpha renamed");
        assert_eq!(updated.body, "changed");
        assert_eq!(updated.tags, vec!["ideas", "project-docs"]);
        assert_eq!(updated.created_at, first.created_at);
        assert!(updated.updated_at > first.updated_at);
        // Keep the source session when changing the note's project.
        assert_eq!(updated.source_cwd.as_deref(), Some("/tmp/a"));
        assert_eq!(
            stored_note(&dir, "n1").unwrap().source_cwd.as_deref(),
            Some("/tmp/a")
        );

        let edited = upsert(&dir, "n1", "Alpha renamed", "another edit");
        assert_eq!(edited.source_cwd.as_deref(), Some("/tmp/a"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn changing_only_project_preserves_note_order() {
        let dir = temp_dir("project-order");
        let mut input = NoteUpsert {
            id: "older".into(),
            title: "Plan".into(),
            body: "Keep this text.".into(),
            tags: vec!["ideas".into()],
            source_session_id: Some("original-session".into()),
            source_cwd: Some("/work/Edefyn".into()),
        };
        let original = upsert_note(&dir, &input).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        upsert_note(
            &dir,
            &NoteUpsert {
                id: "newer".into(),
                title: "Newer note".into(),
                body: "Another note.".into(),
                tags: vec![],
                source_session_id: None,
                source_cwd: None,
            },
        )
        .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));

        input.source_cwd = Some("/work/portognjeeen".into());
        let moved = upsert_note(&dir, &input).unwrap();
        assert_eq!(moved.updated_at, original.updated_at);
        assert_eq!(moved.source_cwd.as_deref(), Some("/work/portognjeeen"));
        assert_eq!(moved.source_session_id, original.source_session_id);
        assert_eq!(moved.slug, original.slug);
        assert_eq!(moved.created_at, original.created_at);

        let listed = all_notes(&dir);
        assert_eq!(listed[0].id, "newer");
        assert_eq!(listed[1].id, "older");
        assert_eq!(listed[1].updated_at, original.updated_at);
        assert_eq!(listed[1].source_cwd, moved.source_cwd);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn slug_collisions_get_a_numeric_suffix() {
        let dir = temp_dir("slug-collisions");
        let first = upsert(&dir, "n1", "Auth approach", "a");
        let second = upsert(&dir, "n2", "Auth approach", "b");
        assert_eq!(first.slug, "auth-approach");
        assert_eq!(second.slug, "auth-approach-2");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_title_becomes_untitled() {
        let dir = temp_dir("untitled");
        let note = upsert(&dir, "n1", "   ", "");
        assert_eq!(note.title, "Untitled");
        assert_eq!(note.slug, "untitled");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn note_image_names_are_safe_and_keep_supported_extensions() {
        assert_eq!(
            note_image_names(Path::new("/tmp/Architecture draft [2].PNG")).unwrap(),
            (
                "Architecture draft [2].PNG".into(),
                "Architecture-draft--2.png".into()
            )
        );
        assert!(note_image_names(Path::new("/tmp/archive.zip")).is_err());
    }

    #[test]
    fn note_asset_paths_cannot_escape_app_data() {
        assert_eq!(
            validate_note_asset_path("/note-assets/note-1/123-image.png").unwrap(),
            PathBuf::from("note-assets/note-1/123-image.png")
        );
        assert!(validate_note_asset_path("/note-assets/note-1/../secret.png").is_err());
        assert!(validate_note_asset_path("/other/note-1/image.png").is_err());
    }

    #[test]
    fn delete_removes_the_document() {
        let dir = temp_dir("delete");
        upsert(&dir, "n1", "Gone", "bye");
        assert!(stored_note(&dir, "n1").is_some());
        std::fs::remove_file(note_file(&dir, "n1")).unwrap();
        assert!(stored_note(&dir, "n1").is_none());
        assert!(all_notes(&dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn slugify_strips_punctuation() {
        assert_eq!(slugify("Hello, World!"), "hello-world");
        assert_eq!(slugify("***"), "note");
        assert_eq!(slugify("Ä"), "note");
    }
}
