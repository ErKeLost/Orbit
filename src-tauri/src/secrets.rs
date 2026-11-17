//! 1Password references and private secret files.
//!
//! A setting may store `op://vault/item/field` instead of the secret. Pi still
//! reads a real key from `auth.json`, so the reference is kept beside it and
//! resolved with `op read` at save time. The resolved value is never returned
//! to the webview.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;

// From T3 `secret-provider-onepassword` `definition.ts`. Names may contain spaces;
// the reference is still one `op read` argument, so it cannot contain a line break.
const MAX_REFERENCE_LENGTH: usize = 1024;

pub fn is_op_reference(value: &str) -> bool {
    let value = value.trim();
    if value.len() > MAX_REFERENCE_LENGTH || value.contains(['\n', '\r']) {
        return false;
    }
    reference_matches(value)
}

fn reference_matches(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("op://") else { return false };
    let (path, query) = rest.split_once('?').map(|(path, query)| (path, Some(query))).unwrap_or((rest, None));
    let parts: Vec<&str> = path.split('/').collect();
    if !(3..=4).contains(&parts.len()) || parts.iter().any(|part| !name_ok(part)) {
        return false;
    }
    match query {
        None => true,
        Some(query) => {
            let mut pieces = query.split('=');
            let key = pieces.next().unwrap_or("");
            let val = pieces.next().unwrap_or("");
            pieces.next().is_none()
                && !key.is_empty()
                && key.chars().all(|ch| ch.is_ascii_lowercase() || ch == '-')
                && !val.is_empty()
                && val.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
        }
    }
}

fn name_ok(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else { return false };
    if !first.is_ascii_alphanumeric() && first != '.' && first != '_' && first != '-' {
        return false;
    }
    let Some(last) = value.chars().last() else { return false };
    if !last.is_ascii_alphanumeric() && last != '.' && last != '_' && last != '-' {
        return false;
    }
    value.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-' | ' '))
}

pub fn read_op(reference: &str) -> Result<String, String> {
    let reference = reference.trim();
    if !is_op_reference(reference) {
        return Err("不是 1Password 引用".into());
    }
    let output = Command::new("op")
        .args(["read", reference])
        .output()
        .map_err(|error| format!("无法运行 op：{error}。先安装并登录 1Password CLI"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "1Password 没有读到这个引用。确认 op 已登录，引用形如 op://vault/item/field".into()
        } else {
            stderr
        });
    }
    let secret = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if secret.is_empty() {
        return Err("1Password 返回了空值".into());
    }
    Ok(secret)
}

fn refs_path(dir: &Path) -> PathBuf {
    dir.join("secret-refs.json")
}

fn read_refs(dir: &Path) -> Value {
    std::fs::read_to_string(refs_path(dir))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| json!({ "providers": {} }))
}

fn write_refs(dir: &Path, value: &Value) -> Result<(), String> {
    let path = refs_path(dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let text = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    std::fs::write(&path, text).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

pub fn remember_ref(dir: &Path, provider: &str, reference: &str) -> Result<(), String> {
    let mut refs = read_refs(dir);
    let providers = refs
        .as_object_mut()
        .and_then(|object| object.entry("providers").or_insert_with(|| json!({})).as_object_mut())
        .ok_or("secret-refs.json 不是对象")?;
    providers.insert(provider.to_string(), json!(reference.trim()));
    write_refs(dir, &refs)
}

pub fn forget_ref(dir: &Path, provider: &str) -> Result<(), String> {
    let mut refs = read_refs(dir);
    if let Some(providers) = refs.get_mut("providers").and_then(Value::as_object_mut) {
        providers.remove(provider);
    }
    write_refs(dir, &refs)
}

pub fn ref_for(dir: &Path, provider: &str) -> Option<String> {
    read_refs(dir)
        .get("providers")
        .and_then(|items| items.get(provider))
        .and_then(Value::as_str)
        .filter(|value| is_op_reference(value))
        .map(ToOwned::to_owned)
}

#[cfg(test)]
mod tests {
    use super::is_op_reference;

    #[test]
    fn accepts_a_secret_reference_and_rejects_a_value() {
        assert!(is_op_reference("op://Private/GitHub/credential"));
        assert!(is_op_reference("op://has space/item/field"));
        assert!(!is_op_reference("sk-live"));
        assert!(!is_op_reference("op://only/two"));
        assert!(!is_op_reference("op:// /item/field"));
    }
}
