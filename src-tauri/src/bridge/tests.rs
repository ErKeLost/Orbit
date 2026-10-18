//! The bridge registry, Pi runtime resolution, and the streaming batch that
//! the session reader drives (which now lives in `pi_session`).
use super::*;
use crate::pi_session::{is_pi_burst_event, safe_pi_diagnostic, PiEventBatch};
use crate::sessions_cmd::remove_jsonl_files;
use std::time::Duration;

#[test]
fn pi_event_batch_holds_only_while_upstream_still_has_data() {
    let mut batch = PiEventBatch::new(8, Duration::from_secs(60));
    assert!(batch.push(json!({"type": "message_update"}), true).is_none());
    assert!(batch.push(json!({"type": "message_update"}), true).is_none());
    // 缓冲区排空 → 立刻冲刷，不把已到手的事件压着等下一行
    let flushed = batch.push(json!({"type": "message_update"}), false).unwrap();
    assert_eq!(flushed.len(), 3);
    assert!(batch.take().is_none(), "flush 之后批必须是空的");
}

#[test]
fn pi_event_batch_flushes_at_the_size_cap() {
    let mut batch = PiEventBatch::new(3, Duration::from_secs(60));
    assert!(batch.push(json!({"type": "message_update"}), true).is_none());
    assert!(batch.push(json!({"type": "message_update"}), true).is_none());
    let flushed = batch.push(json!({"type": "message_update"}), true).unwrap();
    assert_eq!(flushed.len(), 3);
}

#[test]
fn pi_event_batch_take_is_none_when_empty() {
    let mut batch = PiEventBatch::new(8, Duration::from_secs(60));
    assert!(batch.take().is_none());
}

#[test]
fn pi_event_batching_only_swallows_burst_events() {
    // 只有连发的流式事件允许进批；落定/响应/错误类必须逐条立即转发。
    for kind in ["message_update", "tool_execution_update"] {
        assert!(is_pi_burst_event(&json!({"type": kind, "payload": {}})));
    }
    for kind in [
        "message_start",
        "message_end",
        "agent_start",
        "agent_end",
        "agent_settled",
        "tool_execution_start",
        "tool_execution_end",
        "response",
        "queue_update",
    ] {
        assert!(!is_pi_burst_event(&json!({"type": kind})), "{kind} must not be batched");
    }
    assert!(!is_pi_burst_event(&json!({"type": 12})));
    assert!(!is_pi_burst_event(&json!({})));
}

fn temporary_root(label: &str) -> PathBuf {
    let suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!("pi-gui-{label}-{}-{suffix}", std::process::id()))
}

#[test]
fn project_pi_resolution_prefers_the_bundled_cli_for_nested_workspaces() {
    let root = temporary_root("pi-resolution");
    let nested = root.join("packages/app/src");
    let bundle = root.join("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
    fs::create_dir_all(&nested).unwrap();
    fs::create_dir_all(bundle.parent().unwrap()).unwrap();
    fs::write(&bundle, "#!/usr/bin/env node\n").unwrap();

    let (resolved, source) = pi_path_for_project(None, &nested).unwrap();
    assert_eq!(resolved, bundle.canonicalize().unwrap());
    assert_eq!(source, "project");

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn project_pi_resolution_uses_bundle_entrypoint_when_both_builds_exist() {
    let root = temporary_root("pi-resolution-order");
    let nested = root.join("workspace");
    let bundle = root.join("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
    let legacy = root.join("node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
    fs::create_dir_all(&nested).unwrap();
    fs::create_dir_all(bundle.parent().unwrap()).unwrap();
    fs::write(&bundle, "bundle").unwrap();
    fs::write(&legacy, "legacy").unwrap();

    assert_eq!(
        bundled_pi_path(&nested).unwrap(),
        bundle.canonicalize().unwrap()
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn pi_diagnostics_are_bounded_redacted_and_ignore_secrets() {
    let home = PathBuf::from("/Users/example");
    let lines = vec![
        "Authorization: Bearer private-value".to_string(),
        "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/example/runtime/helper.ts'"
            .to_string(),
    ];
    let message = safe_pi_diagnostic(&lines, &home).unwrap();
    assert!(message.contains("ERR_MODULE_NOT_FOUND"));
    assert!(message.contains("~/runtime/helper.ts"));
    assert!(!message.contains("private-value"));
    assert!(message.len() <= 500);
}

fn worker() -> Worker {
    let mut child = Command::new("/bin/cat")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    let stdin = child.stdin.take().unwrap();
    Worker {
        child: Arc::new(Mutex::new(child)),
        stdin,
        cwd: std::env::temp_dir(),
    }
}
#[test]
fn resolve_answers_with_the_worker_that_owns_a_path_spelling() {
    let bridge = Bridge::default();
    let root = std::env::temp_dir().join(format!(
        "orbit-bridge-resolve-{}",
        std::process::id()
    ));
    let real = root.join("project");
    let alias = root.join("link");
    fs::create_dir_all(&real).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&real, &alias).unwrap();
    #[cfg(not(unix))]
    let alias = real.clone();

    let canonical = real.canonicalize().unwrap();
    let id = alias.to_string_lossy().into_owned();
    let mut owned = worker();
    owned.cwd = canonical.clone();
    bridge.0.lock().unwrap().insert(id.clone(), owned);

    // Sending resolves the alias so a phone's spelling reaches the worker…
    assert!(bridge
        .send(&id, json!({"type":"get_state"}))
        .is_ok());
    // …and `resolve` publishes which connection did, which is what lets the
    // phone attach to a project the desktop has open under another spelling.
    let (resolved_id, resolved_cwd) = bridge.resolve(&id).unwrap();
    assert_eq!(resolved_id, id);
    assert_eq!(resolved_cwd, canonical.to_string_lossy());
    // Trailing slashes and unknown paths are handled without panicking.
    assert!(bridge.resolve(&format!("{id}/")).is_some());
    assert!(bridge.resolve(&root.join("missing").to_string_lossy()).is_none());

    bridge.stop();
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn disconnecting_one_project_keeps_the_other_process_alive() {
    let bridge = Bridge::default();
    let a = worker();
    let b = worker();
    let b_child = b.child.clone();
    bridge.0.lock().unwrap().insert("a".into(), a);
    bridge.0.lock().unwrap().insert("b".into(), b);
    bridge.stop_project("a");
    assert!(!bridge.0.lock().unwrap().contains_key("a"));
    assert!(bridge.0.lock().unwrap().contains_key("b"));
    assert!(b_child.lock().unwrap().try_wait().unwrap().is_none());
    bridge.stop();
    assert!(b_child.lock().unwrap().try_wait().unwrap().is_some());
}

#[test]
fn stale_exit_cannot_remove_a_replacement_worker() {
    let bridge = Bridge::default();
    let first = worker();
    let first_child = first.child.clone();
    bridge.0.lock().unwrap().insert("same".into(), first);
    let replacement = worker();
    let replacement_child = replacement.child.clone();
    bridge.0.lock().unwrap().insert("same".into(), replacement);

    assert!(!remove_worker_if_current(&bridge.0, "same", &first_child));
    assert!(bridge.0.lock().unwrap().contains_key("same"));
    assert!(remove_worker_if_current(
        &bridge.0,
        "same",
        &replacement_child
    ));
    assert!(!bridge.0.lock().unwrap().contains_key("same"));

    if let Ok(mut child) = first_child.lock() {
        let _ = child.kill();
        let _ = child.wait();
    }
    if let Ok(mut child) = replacement_child.lock() {
        let _ = child.kill();
        let _ = child.wait();
    };
}

#[test]
fn send_accepts_a_canonical_alias_for_an_existing_project_worker() {
    let bridge = Bridge::default();
    let root = temporary_root("bridge-alias");
    fs::create_dir_all(&root).unwrap();
    let alias = format!("{}/", root.display());
    let worker = worker();
    bridge.0.lock().unwrap().insert(
        alias,
        Worker {
            cwd: root.canonicalize().unwrap(),
            ..worker
        },
    );

    bridge
        .send(&root.to_string_lossy(), json!({"type":"get_state"}))
        .unwrap();
    bridge.stop();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn remove_jsonl_files_clears_nested_session_history_only() {
    let root = temporary_root("clear-sessions");
    let nested = root.join("project");
    fs::create_dir_all(&nested).unwrap();
    fs::write(root.join("one.jsonl"), "{}").unwrap();
    fs::write(nested.join("two.jsonl"), "{}").unwrap();
    fs::write(nested.join("keep.txt"), "keep").unwrap();

    assert_eq!(remove_jsonl_files(&root).unwrap(), 2);
    assert!(!root.join("one.jsonl").exists());
    assert!(!nested.join("two.jsonl").exists());
    assert!(nested.join("keep.txt").exists());
    fs::remove_dir_all(root).unwrap();
}
