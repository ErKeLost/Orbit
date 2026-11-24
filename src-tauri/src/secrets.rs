//! 1Password references and private secret files.
//!
//! A setting may store `op://vault/item/field` instead of the secret. Pi still
//! reads a real key from `auth.json`, so the reference is kept beside it and
//! resolved with `op read` at save time. The resolved value is never returned
//! to the webview.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

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
    read_command(&["op", "read", reference], "op")
}

// ---------------------------------------------------------------------------
// 通用命令引用（`!command args`）
// ---------------------------------------------------------------------------

/// 命令引用的上限，和 1Password 引用保持同一量级。
const MAX_COMMAND_LENGTH: usize = 2048;
/// 解析超时：慢的 vault 不该把界面卡死，也不该静默降级成空 key。
const COMMAND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// 一项设置可以存 `op://vault/item/field`，也可以存 `!` 开头的命令。两者都只存
/// **引用**，真正的密钥在保存时解析一次落盘，和 Pi 自己 `auth.json` 里
/// `!command` 的语义一致。
pub fn is_command_reference(value: &str) -> bool {
    let value = value.trim();
    value.len() > 1
        && value.len() <= MAX_COMMAND_LENGTH
        && value.starts_with('!')
        && !value.contains(['\n', '\r'])
        && !value[1..].trim().is_empty()
}

/// 这项设置存的是引用（而不是密钥本身）。
pub fn is_reference(value: &str) -> bool {
    is_op_reference(value) || is_command_reference(value)
}

/// 把任意引用解析成真实密钥。调用点只需要这一层：`op://` 是命令形式的一个内置别名。
pub fn resolve(reference: &str) -> Result<String, String> {
    let reference = reference.trim();
    if is_op_reference(reference) {
        return read_op(reference);
    }
    if !is_command_reference(reference) {
        return Err("不是密钥引用".into());
    }
    // 不经 shell：`shell_words::split` 只拆词，`$(...)`、`|`、`&&` 都只是普通参数。
    let words = shell_words::split(reference[1..].trim())
        .map_err(|_| "密钥命令的引号未闭合".to_string())?;
    let program = words.first().cloned().ok_or("密钥命令为空")?;
    let args: Vec<String> = words.into_iter().skip(1).collect();
    read_command(
        &std::iter::once(program.as_str())
            .chain(args.iter().map(String::as_str))
            .collect::<Vec<_>>(),
        &program,
    )
}

fn read_command(argv: &[&str], program: &str) -> Result<String, String> {
    let (executable, args) = match argv.split_first() {
        Some(parts) => parts,
        None => return Err("密钥命令为空".into()),
    };
    let mut command = Command::new(executable);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::hide_window_console(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("无法运行 {program}：{error}"))?;
    let deadline = std::time::Instant::now() + COMMAND_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {}
            Err(error) => {
                let _ = child.kill();
                return Err(format!("等待 {program} 失败：{error}"));
            }
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "{program} 在 {} 秒内没有返回",
                COMMAND_TIMEOUT.as_secs()
            ));
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let output = child
        .wait_with_output()
        .map_err(|error| format!("读取 {program} 输出失败：{error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("{program} 退出码 {:?}", output.status.code())
        } else {
            stderr
        });
    }
    let secret = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if secret.is_empty() {
        return Err(format!("{program} 返回了空值"));
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
        .filter(|value| is_reference(value))
        .map(ToOwned::to_owned)
}

#[cfg(test)]
mod tests {
    use super::{is_command_reference, is_op_reference, is_reference, resolve};

    #[test]
    fn accepts_a_secret_reference_and_rejects_a_value() {
        assert!(is_op_reference("op://Private/GitHub/credential"));
        assert!(is_op_reference("op://has space/item/field"));
        assert!(!is_op_reference("sk-live"));
        assert!(!is_op_reference("op://only/two"));
        assert!(!is_op_reference("op:// /item/field"));
    }

    #[test]
    fn command_references_never_treat_a_secret_as_one() {
        assert!(is_command_reference("!echo hello"));
        assert!(!is_command_reference("!"));
        assert!(!is_command_reference("!   "));
        assert!(!is_command_reference("sk-!live"));
        assert!(!is_command_reference("!echo a\nb"));
        // op:// 引用仍然是引用，两条路径都能被 `ref_for` 记住。
        assert!(is_reference("op://Private/GitHub/credential"));
        assert!(is_reference("!printf key"));
        assert!(!is_reference("sk-live"));
    }

    #[cfg(unix)]
    #[test]
    fn a_command_reference_is_split_without_a_shell() {
        let secret = resolve("!printf 'sk-test'").unwrap();
        assert_eq!(secret, "sk-test");
        // `$(...)` 与管道都只是普通参数，不会被 shell 执行。
        let echoed = resolve("!echo $(whoami) | cat").unwrap();
        assert!(echoed.contains("$(whoami)"), "{echoed}");
        assert!(!echoed.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn a_failing_command_reports_its_stderr() {
        let failure = resolve("!sh -c 'echo vault locked >&2; exit 3'").unwrap_err();
        assert!(failure.contains("vault locked"), "{failure}");
    }
}
