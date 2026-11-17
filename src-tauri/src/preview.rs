//! Structured previews for formats the code editor would only garble.
//!
//! Office files, EPUB and zip archives are zip containers. SQLite is asked of
//! the system `sqlite3`. Notebooks are JSON. The webview gets a bounded table
//! or chapter, never the raw bytes.

use serde_json::{json, Value};
use std::path::Path;
use std::process::Command;

const MAX_BYTES: u64 = 32 * 1024 * 1024;
const MAX_ROWS: usize = 80;
const MAX_COLS: usize = 40;
const MAX_ENTRIES: usize = 400;
const MAX_TEXT: usize = 24_000;

fn unzip_text(path: &Path, name: &str) -> Option<String> {
    let output = Command::new(unzip_bin()).arg("-p").arg(path).arg(name).output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn unzip_bin() -> &'static str {
    if Path::new("/usr/bin/unzip").exists() { "/usr/bin/unzip" } else { "unzip" }
}

fn xml_texts(xml: &str, tag: &str) -> Vec<String> {
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find(&open) {
        let after = &rest[start + open.len()..];
        let Some(content_at) = after.find('>') else { break };
        let body = &after[content_at + 1..];
        let Some(end) = body.find(&close) else { break };
        let text = decode_entities(body[..end].trim());
        if !text.is_empty() {
            out.push(text);
        }
        rest = &body[end + close.len()..];
    }
    out
}

fn decode_entities(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

fn column_index(label: &str) -> Option<usize> {
    let mut index = 0usize;
    let mut seen = false;
    for ch in label.chars() {
        if !ch.is_ascii_alphabetic() {
            break;
        }
        seen = true;
        index = index * 26 + (ch.to_ascii_uppercase() as usize - 'A' as usize + 1);
    }
    seen.then_some(index.saturating_sub(1))
}

fn cell_ref(reference: &str) -> Option<(usize, usize)> {
    let col = column_index(reference)?;
    let row: usize = reference.chars().skip_while(|ch| ch.is_ascii_alphabetic()).collect::<String>().parse().ok()?;
    Some((row.saturating_sub(1), col))
}

fn shared_strings(xml: &str) -> Vec<String> {
    xml.split("<si").skip(1).map(|item| xml_texts(item, "t").join("")).collect()
}

fn sheet_rows(xml: &str, strings: &[String]) -> Vec<Vec<String>> {
    let mut grid: Vec<Vec<String>> = Vec::new();
    for cell in xml.split("<c ").skip(1) {
        let reference = cell.find("r=\"").and_then(|at| cell[at + 3..].split('"').next()).unwrap_or("");
        let Some((row, col)) = cell_ref(reference) else { continue };
        if row >= MAX_ROWS || col >= MAX_COLS {
            continue;
        }
        let kind = cell.find("t=\"").and_then(|at| cell[at + 3..].split('"').next()).unwrap_or("");
        let value = if kind == "inlineStr" {
            xml_texts(cell, "t").join("")
        } else {
            let raw = cell.find("<v>").and_then(|at| cell[at + 3..].split("</v>").next()).unwrap_or("").trim().to_string();
            if kind == "s" {
                raw.parse::<usize>().ok().and_then(|index| strings.get(index)).cloned().unwrap_or(raw)
            } else {
                decode_entities(&raw)
            }
        };
        if grid.len() <= row {
            grid.resize(row + 1, Vec::new());
        }
        if grid[row].len() <= col {
            grid[row].resize(col + 1, String::new());
        }
        grid[row][col] = value;
    }
    let width = grid.iter().map(Vec::len).max().unwrap_or(0).min(MAX_COLS);
    for row in &mut grid {
        row.resize(width, String::new());
    }
    grid
}

fn ensure_preview_size(path: &Path) -> Result<(), String> {
    let meta = std::fs::metadata(path).map_err(|error| format!("{}: {error}", path.display()))?;
    if meta.len() > MAX_BYTES {
        return Err("文件超过 32MB，不做预览".into());
    }
    Ok(())
}

fn preview_archive(path: &Path) -> Result<Value, String> {
    ensure_preview_size(path)?;
    let output = Command::new(unzip_bin()).arg("-l").arg(path).output().map_err(|error| format!("无法运行 unzip：{error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let listing = String::from_utf8_lossy(&output.stdout).into_owned();
    let name_at = listing.lines().find_map(|line| line.find("Name")).unwrap_or(28);
    let mut entries = Vec::new();
    for line in listing.lines() {
        let Some(size) = line.split_whitespace().next().and_then(|value| value.parse::<u64>().ok()) else { continue };
        if !line.contains('-') || line.len() <= name_at { continue; }
        let name = line[name_at..].trim();
        if name.is_empty() || name == "Name" { continue; }
        entries.push(json!({ "name": name, "size": size }));
        if entries.len() >= MAX_ENTRIES { break; }
    }
    Ok(json!({ "kind": "archive", "entries": entries, "truncated": entries.len() >= MAX_ENTRIES }))
}

fn preview_docx(path: &Path) -> Result<Value, String> {
    ensure_preview_size(path)?;
    let xml = unzip_text(path, "word/document.xml").ok_or("这份 docx 没有正文")?;
    let mut paragraphs = Vec::new();
    for paragraph in xml.split("<w:p").skip(1) {
        let text = xml_texts(paragraph, "w:t").join("");
        if !text.trim().is_empty() {
            paragraphs.push(text);
        }
        if paragraphs.len() >= 400 {
            break;
        }
    }
    Ok(json!({ "kind": "document", "paragraphs": paragraphs }))
}

fn preview_xlsx(path: &Path) -> Result<Value, String> {
    ensure_preview_size(path)?;
    let strings = unzip_text(path, "xl/sharedStrings.xml").map(|xml| shared_strings(&xml)).unwrap_or_default();
    let mut sheets = Vec::new();
    for index in 1..=8 {
        let name = format!("xl/worksheets/sheet{index}.xml");
        let Some(xml) = unzip_text(path, &name) else { continue };
        sheets.push(json!({ "name": format!("Sheet {index}"), "rows": sheet_rows(&xml, &strings) }));
    }
    if sheets.is_empty() {
        return Err("这份表格没有工作表".into());
    }
    Ok(json!({ "kind": "sheet", "sheets": sheets }))
}

fn preview_pptx(path: &Path) -> Result<Value, String> {
    ensure_preview_size(path)?;
    let mut slides = Vec::new();
    for index in 1..=40 {
        let name = format!("ppt/slides/slide{index}.xml");
        let Some(xml) = unzip_text(path, &name) else {
            if index > 1 {
                break;
            }
            continue;
        };
        let lines = xml_texts(&xml, "a:t");
        slides.push(json!({ "title": lines.first().cloned().unwrap_or_else(|| format!("幻灯片 {index}")), "lines": lines }));
    }
    Ok(json!({ "kind": "slides", "slides": slides }))
}

fn preview_epub(path: &Path) -> Result<Value, String> {
    ensure_preview_size(path)?;
    let container = unzip_text(path, "META-INF/container.xml").unwrap_or_default();
    let opf = container
        .split("full-path=\"")
        .nth(1)
        .and_then(|value| value.split('"').next())
        .unwrap_or("OEBPS/content.opf");
    let package = unzip_text(path, opf).unwrap_or_default();
    let title = xml_texts(&package, "dc:title").into_iter().next().unwrap_or_else(|| "EPUB".into());
    let base = Path::new(opf).parent().map(|path| path.to_string_lossy().to_string()).unwrap_or_default();
    let mut chapters = Vec::new();
    for item in package.split("<item ").skip(1).take(12) {
        let href = item.split("href=\"").nth(1).and_then(|value| value.split('"').next()).unwrap_or("");
        let media = item.split("media-type=\"").nth(1).and_then(|value| value.split('"').next()).unwrap_or("");
        if !media.contains("html") && !href.ends_with(".xhtml") && !href.ends_with(".html") {
            continue;
        }
        let joined = if base.is_empty() { href.to_string() } else { format!("{base}/{href}") };
        let Some(html) = unzip_text(path, &joined).or_else(|| unzip_text(path, href)) else { continue };
        let stripped = html.replace("<script", "<!--").replace("</script>", "-->");
        let capped: String = stripped.chars().take(MAX_TEXT).collect();
        chapters.push(json!({ "title": href, "html": capped }));
        if chapters.len() >= 3 {
            break;
        }
    }
    Ok(json!({ "kind": "epub", "title": title, "chapters": chapters }))
}

fn sqlite_bin() -> String {
    if Path::new("/usr/bin/sqlite3").exists() {
        "/usr/bin/sqlite3".into()
    } else {
        "sqlite3".into()
    }
}

fn sqlite_query(path: &Path, sql: &str) -> Result<String, String> {
    let output = Command::new(sqlite_bin())
        .arg("-json")
        .arg(path)
        .arg(sql)
        .output()
        .map_err(|error| format!("无法运行 sqlite3：{error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn ident(name: &str) -> Option<String> {
    if name.is_empty() || !name.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_') {
        return None;
    }
    Some(name.to_string())
}

fn preview_sqlite(path: &Path) -> Result<Value, String> {
    let listed = sqlite_query(path, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 12")?;
    let tables: Vec<Value> = serde_json::from_str(&listed).unwrap_or_default();
    let mut out = Vec::new();
    for table in tables {
        let Some(name) = table.get("name").and_then(Value::as_str).and_then(ident) else { continue };
        let rows_text = sqlite_query(path, &format!("SELECT * FROM \"{name}\" LIMIT {MAX_ROWS}"))?;
        let rows: Vec<Value> = serde_json::from_str(&rows_text).unwrap_or_default();
        out.push(json!({ "name": name, "rows": rows }));
    }
    Ok(json!({ "kind": "sqlite", "tables": out }))
}

fn preview_notebook(path: &Path) -> Result<Value, String> {
    let text = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
    let value: Value = serde_json::from_str(&text).map_err(|error| format!("笔记本不是 JSON：{error}"))?;
    let mut cells = Vec::new();
    for cell in value.get("cells").and_then(Value::as_array).into_iter().flatten().take(40) {
        let kind = cell.get("cell_type").and_then(Value::as_str).unwrap_or("code");
        let source = match cell.get("source") {
            Some(Value::String(text)) => text.clone(),
            Some(Value::Array(parts)) => parts.iter().filter_map(Value::as_str).collect::<String>(),
            _ => String::new(),
        };
        cells.push(json!({ "kind": kind, "source": source.chars().take(8_000).collect::<String>() }));
    }
    Ok(json!({ "kind": "notebook", "cells": cells }))
}

#[tauri::command]
pub fn preview_document(path: String) -> Result<Value, String> {
    let path = Path::new(path.trim());
    if !path.is_file() {
        return Err("文件不存在".into());
    }
    let extension = path.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
    match extension.as_str() {
        "zip" | "jar" => preview_archive(path),
        "docx" => preview_docx(path),
        "xlsx" | "xlsm" => preview_xlsx(path),
        "pptx" => preview_pptx(path),
        "epub" => preview_epub(path),
        "sqlite" | "sqlite3" | "db" => preview_sqlite(path),
        "ipynb" => preview_notebook(path),
        _ => Err("这个格式没有预览".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::{cell_ref, column_index, xml_texts};

    #[test]
    fn reads_a_cell_reference() {
        assert_eq!(column_index("AA"), Some(26));
        assert_eq!(cell_ref("B2"), Some((1, 1)));
    }

    #[test]
    fn pulls_text_nodes() {
        let xml = r#"<w:t>你好</w:t><w:t xml:space="preserve"> 世界</w:t>"#;
        assert_eq!(xml_texts(xml, "w:t"), vec!["你好".to_string(), "世界".to_string()]);
    }
}
