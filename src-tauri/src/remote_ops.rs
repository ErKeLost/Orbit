//! The desktop's command surface, mirrored to a paired phone.
//!
//! The phone runs the same React application as the desktop, so it asks the
//! same questions: list this directory, read this file, stage this change,
//! commit, open a terminal. Answering each one with a hand-written remote
//! operation would mean two implementations of every feature and two places to
//! keep in step — which is exactly how a phone ends up with a file tree that
//! cannot open files.
//!
//! Instead the phone's `invoke` arrives here and is dispatched to the *same*
//! functions the local webview calls. There is one implementation, one set of
//! arguments, and one error message.
//!
//! # The boundary
//!
//! [`REMOTE_COMMANDS`] is a closed list, checked before an argument is looked
//! at: a name that is not in it never reaches a function. It is deliberately
//! *not* "every command": the exclusions are commands that are about *this
//! device* rather than about the workspace —
//!
//! * `runtime_environment` / `splash_ready` / `mobile_update_*`: the phone's own
//!   bootstrap (its APK update is installed on the phone, never on the Mac);
//! * `remote_host_*` / relay settings: the pairing host's own lifecycle. A phone
//!   that could stop the Host would be cutting the branch it sits on;
//! * `set_keep_awake`: the wake assertion belongs to the machine it protects;
//! * `pi_connect`: it hands out a Tauri event channel, which exists only inside
//!   one webview (the phone attaches over `connection.attach` instead).
//!
//! `ax_observe` is included on purpose — computer use needs the accessibility
//! snapshot, and a phone that asked for it is a phone that is driving this
//! machine.
//!
//! Everything else — files, git, terminal input, notes, automations, providers,
//! inboxes — is reachable, including the write paths, because a paired phone is
//! the same user on the same machine. `docs/MOBILE.md` states that trade in the
//! UI: the pairing URI is a key to this computer's filesystem.

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::{automations, bridge, git, github_inbox, gitlab, media, notes, pty_term, search};
#[cfg(target_os = "macos")]
use crate::ax;

/// Commands a paired phone may call, by name. Default-deny.
pub const REMOTE_COMMANDS: &[&str] = &[
    // --- files -------------------------------------------------------------
    "list_dir",
    "read_text_file",
    "file_meta",
    "write_text_file",
    "create_dir",
    "rename_path",
    "delete_path",
    "list_project_files",
    "search_files",
    "search_sessions",
    "media_meta",
    // Bytes, not just metadata: the asset protocol is "this webview reads this
    // machine's disk", which a phone has no equivalent of. Capped by
    // `media::MAX_REMOTE_MEDIA_BYTES`; the desktop keeps using the asset
    // protocol and is not affected by that cap.
    "read_media_file",
    // `clipboard_file_paths`, `read_file_attachment` and `save_media_file` are
    // deliberately absent: their paths come from a picker or a clipboard on the
    // device in front of the user, so on a phone they describe the *phone's*
    // filesystem. Running them on the Mac would paste the wrong image or save
    // to a path that does not exist there.
    // --- git ---------------------------------------------------------------
    "git_diff_stats",
    "git_changed_files",
    "git_branches",
    "git_checkout",
    "git_create_branch",
    "git_diff_index",
    "git_diff_files",
    "git_file_diff",
    "git_history",
    "git_commit_files",
    "git_commit_file_diff",
    "git_stage_file",
    "git_stage_contents",
    "git_unstage_file",
    "git_discard_file",
    "git_discard_all",
    "git_stage_all",
    "git_unstage_all",
    "git_commit",
    "git_head_message",
    "git_push",
    "git_pull",
    "git_sync",
    "git_staged_context",
    "git_range_context",
    "git_pr_status",
    "git_pr_create",
    // --- inboxes -----------------------------------------------------------
    "git_github_status",
    "git_github_repo",
    "git_github_repositories",
    "git_github_work_items",
    "git_github_work_item",
    "git_github_work_item_details",
    "git_github_work_item_thread",
    "git_github_work_item_comment",
    "git_github_pr_action",
    "git_github_pr_diff",
    "git_github_pr_checks",
    "git_github_check_details",
    "gitlab_status",
    "gitlab_set_config",
    "gitlab_repo",
    "gitlab_list_work_items",
    "gitlab_list_todos",
    "gitlab_work_item_details",
    "gitlab_work_item_thread",
    "gitlab_work_item_comment",
    "gitlab_mr_diff",
    // --- pi sessions -------------------------------------------------------
    "discover",
    "pi_send",
    "pi_oneshot",
    "pi_disconnect",
    "list_sessions",
    "delete_session",
    "clear_sessions",
    "session_turn_durations",
    "open_pi_terminal",
    // --- terminal ----------------------------------------------------------
    "pty_spawn",
    "pty_write",
    "pty_resize",
    "pty_status",
    "pty_kill",
    "pty_kill_all",
    // --- notes / automations ----------------------------------------------
    "notes_list",
    "notes_get",
    "notes_upsert",
    "notes_delete",
    "notes_save_image",
    "notes_save_image_data",
    "notes_image_path",
    "automations_list",
    "automations_upsert",
    "automations_delete",
    "automation_runs_list",
    "automation_runs_recover",
    "automation_run_now",
    "automations_claim_due",
    "automation_run_update",
    // --- pi configuration --------------------------------------------------
    "get_gui_settings",
    "set_gui_setting",
    "list_provider_models",
    "list_provider_profiles",
    "probe_provider_models",
    "save_provider",
    "delete_provider",
    "sync_provider_models",
    "set_default_model",
    "get_project_trust_mode",
    "set_project_trust_mode",
    "list_mcp_servers",
    "save_mcp_server",
    "delete_mcp_server",
    "mcp_config_location",
    "computer_use_key_status",
    "save_computer_use_key",
    "computer_use_config",
    "save_computer_use_config",
    "save_computer_use_cloudflare_token",
    "test_computer_use_decision",
    "image_config",
    "save_image_config",
    // macOS only, like the module that implements it: the accessibility
    // snapshot computer use reads.
    "ax_observe",
];

/// Whether a command may be reached from a paired phone.
pub fn allows(command: &str) -> bool {
    REMOTE_COMMANDS.contains(&command)
}

/// Call one mirrored command with the arguments its local caller would have sent.
///
/// Arguments arrive as JSON with the webview's own spelling (Tauri converts
/// `camelCase` payload keys to the Rust parameter names), so the readers below
/// accept either spelling: the difference between `sessionPath` and
/// `session_path` is not worth a silent `None`.
pub async fn dispatch(app: &AppHandle, command: &str, args: Value) -> Result<Value, String> {
    if !allows(command) {
        return Err(format!("命令 {command} 不允许从手机端调用"));
    }
    match command {
        // --- files ---------------------------------------------------------
        "list_dir" => json(git::list_dir(text(&args, "path")?).await?),
        "read_text_file" => json(git::read_text_file(text(&args, "path")?).await?),
        "file_meta" => json(git::file_meta(text(&args, "path")?).await?),
        "write_text_file" => json(git::write_text_file(text(&args, "path")?, text(&args, "contents")?).await?),
        "create_dir" => json(git::create_dir(text(&args, "path")?).await?),
        "rename_path" => json(git::rename_path(text(&args, "from")?, text(&args, "to")?).await?),
        "delete_path" => json(git::delete_path(text(&args, "path")?).await?),
        "list_project_files" => bridge::list_project_files(text(&args, "cwd")?).await,
        "search_files" => json(
            search::search_files(
                text(&args, "cwd")?,
                text(&args, "query")?,
                opt::<usize>(&args, "limit")?,
            )
            .await?,
        ),
        "search_sessions" => json(search::search_sessions(text(&args, "query")?).await?),
        "media_meta" => json(media::media_meta(text(&args, "path")?).await?),
        "read_media_file" => json(media::read_media_file(text(&args, "path")?).await?),
        // --- git -----------------------------------------------------------
        "git_diff_stats" => json(git::git_diff_stats(text(&args, "cwd")?).await?),
        "git_changed_files" => json(git::git_changed_files(text(&args, "cwd")?).await?),
        "git_branches" => json(git::git_branches(text(&args, "cwd")?).await?),
        "git_checkout" => json(
            git::git_checkout(
                text(&args, "cwd")?,
                text(&args, "name")?,
                opt::<String>(&args, "remote")?,
            )
            .await?,
        ),
        "git_create_branch" => {
            json(git::git_create_branch(text(&args, "cwd")?, text(&args, "name")?).await?)
        }
        "git_diff_index" => json(git::git_diff_index(text(&args, "cwd")?).await?),
        "git_diff_files" => json(git::git_diff_files(text(&args, "cwd")?).await?),
        "git_file_diff" => json(
            git::git_file_diff(
                text(&args, "cwd")?,
                text(&args, "relative")?,
                flag(&args, "staged")?,
            )
            .await?,
        ),
        "git_history" => json(
            git::git_history(text(&args, "cwd")?, opt::<u32>(&args, "limit")?).await?,
        ),
        "git_commit_files" => {
            json(git::git_commit_files(text(&args, "cwd")?, text(&args, "sha")?).await?)
        }
        "git_commit_file_diff" => json(
            git::git_commit_file_diff(
                text(&args, "cwd")?,
                text(&args, "sha")?,
                text(&args, "relative")?,
            )
            .await?,
        ),
        "git_stage_file" => json(
            git::git_stage_file(text(&args, "cwd")?, text(&args, "relative")?).await?,
        ),
        "git_stage_contents" => json(
            git::git_stage_contents(
                text(&args, "cwd")?,
                text(&args, "relative")?,
                text(&args, "contents")?,
            )
            .await?,
        ),
        "git_unstage_file" => json(
            git::git_unstage_file(text(&args, "cwd")?, text(&args, "relative")?).await?,
        ),
        "git_discard_file" => json(
            git::git_discard_file(text(&args, "cwd")?, text(&args, "relative")?).await?,
        ),
        "git_discard_all" => json(git::git_discard_all(text(&args, "cwd")?).await?),
        "git_stage_all" => json(git::git_stage_all(text(&args, "cwd")?).await?),
        "git_unstage_all" => json(git::git_unstage_all(text(&args, "cwd")?).await?),
        "git_commit" => json(
            git::git_commit(
                text(&args, "cwd")?,
                text(&args, "message")?,
                flag(&args, "amend")?,
            )
            .await?,
        ),
        "git_head_message" => json(git::git_head_message(text(&args, "cwd")?).await?),
        "git_push" => json(git::git_push(text(&args, "cwd")?).await?),
        "git_pull" => json(git::git_pull(text(&args, "cwd")?).await?),
        "git_sync" => json(git::git_sync(text(&args, "cwd")?).await?),
        "git_staged_context" => json(git::git_staged_context(text(&args, "cwd")?).await?),
        "git_range_context" => json(git::git_range_context(text(&args, "cwd")?).await?),
        "git_pr_status" => json(git::git_pr_status(text(&args, "cwd")?).await?),
        "git_pr_create" => json(
            git::git_pr_create(
                text(&args, "cwd")?,
                text(&args, "title")?,
                text(&args, "body")?,
                text(&args, "base")?,
                text(&args, "head")?,
            )
            .await?,
        ),
        // --- inboxes -------------------------------------------------------
        "git_github_status" => json(github_inbox::git_github_status().await?),
        "git_github_repo" => json(github_inbox::git_github_repo(text(&args, "cwd")?).await?),
        "git_github_repositories" => {
            json(github_inbox::git_github_repositories(text(&args, "cwd")?).await?)
        }
        "git_github_work_items" => json(
            github_inbox::git_github_work_items(
                text(&args, "cwd")?,
                text(&args, "repo")?,
                text(&args, "kind")?,
                flag(&args, "assignedToMe")?,
                text(&args, "state")?,
                text(&args, "search")?,
                opt::<u32>(&args, "limit")?,
            )
            .await?,
        ),
        "git_github_work_item" => json(
            github_inbox::git_github_work_item(
                text(&args, "cwd")?,
                text(&args, "repo")?,
                text(&args, "kind")?,
                integer(&args, "number")?,
            )
            .await?,
        ),
        "git_github_work_item_details" => json(
            github_inbox::git_github_work_item_details(
                text(&args, "cwd")?,
                text(&args, "repo")?,
                text(&args, "kind")?,
                integer(&args, "number")?,
            )
            .await?,
        ),
        "git_github_work_item_thread" => json(
            github_inbox::git_github_work_item_thread(
                text(&args, "cwd")?,
                text(&args, "repo")?,
                text(&args, "kind")?,
                integer(&args, "number")?,
            )
            .await?,
        ),
        "git_github_work_item_comment" => json(
            github_inbox::git_github_work_item_comment(
                text(&args, "cwd")?,
                text(&args, "repo")?,
                text(&args, "kind")?,
                integer(&args, "number")?,
                text(&args, "body")?,
                text(&args, "inReplyTo")?,
            )
            .await?,
        ),
        "git_github_pr_action" => json(
            github_inbox::git_github_pr_action(
                text(&args, "cwd")?,
                text(&args, "repo")?,
                integer(&args, "number")?,
                text(&args, "action")?,
            )
            .await?,
        ),
        "git_github_pr_diff" => json(
            github_inbox::git_github_pr_diff(
                text(&args, "cwd")?,
                text(&args, "repo")?,
                integer(&args, "number")?,
                opt::<bool>(&args, "fullContext")?,
            )
            .await?,
        ),
        "git_github_pr_checks" => json(
            github_inbox::git_github_pr_checks(
                text(&args, "cwd")?,
                text(&args, "repo")?,
                integer(&args, "number")?,
            )
            .await?,
        ),
        "git_github_check_details" => json(
            github_inbox::git_github_check_details(
                text(&args, "cwd")?,
                text(&args, "repo")?,
                text(&args, "jobId")?,
            )
            .await?,
        ),
        "gitlab_status" => json(gitlab::gitlab_status(app.clone())?),
        "gitlab_set_config" => json(
            gitlab::gitlab_set_config(app.clone(), text(&args, "url")?, text(&args, "token")?)
                .await?,
        ),
        "gitlab_repo" => json(gitlab::gitlab_repo(app.clone(), text(&args, "cwd")?).await?),
        "gitlab_list_work_items" => json(
            gitlab::gitlab_list_work_items(
                app.clone(),
                text(&args, "cwd")?,
                text(&args, "kind")?,
                flag(&args, "assignedToMe")?,
                text(&args, "state")?,
                opt::<u32>(&args, "limit")?,
            )
            .await?,
        ),
        "gitlab_list_todos" => json(
            gitlab::gitlab_list_todos(app.clone(), text(&args, "kind")?, opt::<u32>(&args, "limit")?)
                .await?,
        ),
        "gitlab_work_item_details" => json(
            gitlab::gitlab_work_item_details(
                app.clone(),
                text(&args, "repo")?,
                text(&args, "kind")?,
                integer(&args, "number")?,
            )
            .await?,
        ),
        "gitlab_work_item_thread" => json(
            gitlab::gitlab_work_item_thread(
                app.clone(),
                text(&args, "repo")?,
                text(&args, "kind")?,
                integer(&args, "number")?,
            )
            .await?,
        ),
        "gitlab_work_item_comment" => json(
            gitlab::gitlab_work_item_comment(
                app.clone(),
                text(&args, "repo")?,
                text(&args, "kind")?,
                integer(&args, "number")?,
                text(&args, "body")?,
            )
            .await?,
        ),
        "gitlab_mr_diff" => json(
            gitlab::gitlab_mr_diff(
                app.clone(),
                text(&args, "repo")?,
                integer(&args, "number")?,
            )
            .await?,
        ),
        // --- pi sessions ---------------------------------------------------
        "discover" => json(bridge::discover(app.clone()).await?),
        "pi_send" => {
            let state = app.state::<bridge::Bridge>();
            json(bridge::pi_send(
                text(&args, "project")?,
                args_of(&args, "command")?,
                state,
            )?)
        }
        "pi_oneshot" => json(
            bridge::pi_oneshot(
                app.clone(),
                text(&args, "cwd")?,
                text(&args, "prompt")?,
            )
            .await?,
        ),
        "pi_disconnect" => {
            let state = app.state::<bridge::Bridge>();
            bridge::pi_disconnect(app.clone(), text(&args, "project")?, state);
            Ok(Value::Null)
        }
        "list_sessions" => json(bridge::list_sessions(app.clone(), text(&args, "cwd")?).await?),
        "delete_session" => json(bridge::delete_session(text(&args, "sessionPath")?).await?),
        "clear_sessions" => {
            let state = app.state::<bridge::Bridge>();
            bridge::clear_sessions(state).await
        }
        "session_turn_durations" => json(
            bridge::session_turn_durations(app.clone(), text(&args, "sessionPath")?).await?,
        ),
        "open_pi_terminal" => json(
            bridge::open_pi_terminal(
                app.clone(),
                text(&args, "cwd")?,
                opt::<String>(&args, "session")?,
                opt::<Vec<String>>(&args, "piArgs")?,
            )
            .await?,
        ),
        // --- terminal ------------------------------------------------------
        "pty_spawn" => {
            let host = app.state::<pty_term::PtyHost>();
            json(pty_term::pty_spawn(
                app.clone(),
                host,
                text(&args, "id")?,
                text(&args, "cwd")?,
                number::<u16>(&args, "cols")?,
                number::<u16>(&args, "rows")?,
            )?)
        }
        "pty_write" => {
            let host = app.state::<pty_term::PtyHost>();
            json(pty_term::pty_write(host, text(&args, "id")?, text(&args, "data")?)?)
        }
        "pty_resize" => {
            let host = app.state::<pty_term::PtyHost>();
            json(pty_term::pty_resize(
                host,
                text(&args, "id")?,
                number::<u16>(&args, "cols")?,
                number::<u16>(&args, "rows")?,
            )?)
        }
        "pty_status" => {
            let host = app.state::<pty_term::PtyHost>();
            json(pty_term::pty_status(host, text(&args, "id")?)?)
        }
        "pty_kill" => {
            let host = app.state::<pty_term::PtyHost>();
            json(pty_term::pty_kill(host, text(&args, "id")?)?)
        }
        "pty_kill_all" => {
            let host = app.state::<pty_term::PtyHost>();
            json(pty_term::pty_kill_all(host)?)
        }
        // --- notes / automations -------------------------------------------
        "notes_list" => json(notes::notes_list(app.clone())?),
        "notes_get" => json(notes::notes_get(app.clone(), text(&args, "id")?)?),
        "notes_upsert" => {
            let note = required(&args, "note")?;
            json(notes::notes_upsert(app.clone(), note)?)
        }
        "notes_delete" => json(notes::notes_delete(app.clone(), text(&args, "id")?)?),
        "notes_save_image" => json(
            notes::notes_save_image(app.clone(), text(&args, "noteId")?, text(&args, "sourcePath")?)
                .await?,
        ),
        "notes_save_image_data" => json(
            notes::notes_save_image_data(
                app.clone(),
                text(&args, "noteId")?,
                text(&args, "name")?,
                required(&args, "data")?,
            )
            .await?,
        ),
        "notes_image_path" => json(notes::notes_image_path(app.clone(), text(&args, "asset")?)?),
        "automations_list" => json(automations::automations_list(app.clone()).await?),
        "automations_upsert" => json(
            automations::automations_upsert(
                app.clone(),
                required(&args, "input")?,
                integer(&args, "now")?,
            )
            .await?,
        ),
        "automations_delete" => json(
            automations::automations_delete(app.clone(), text(&args, "automationId")?).await?,
        ),
        "automation_runs_list" => json(
            automations::automation_runs_list(
                app.clone(),
                text(&args, "automationId")?,
                opt::<usize>(&args, "limit")?,
            )
            .await?,
        ),
        "automation_runs_recover" => {
            json(automations::automation_runs_recover(app.clone(), integer(&args, "now")?).await?)
        }
        "automation_run_now" => json(
            automations::automation_run_now(
                app.clone(),
                text(&args, "automationId")?,
                integer(&args, "now")?,
            )
            .await?,
        ),
        "automations_claim_due" => json(
            automations::automations_claim_due(
                app.clone(),
                text(&args, "automationId")?,
                integer(&args, "expectedNextRunAt")?,
                integer(&args, "nextRunAt")?,
                integer(&args, "now")?,
            )
            .await?,
        ),
        "automation_run_update" => json(
            automations::automation_run_update(
                app.clone(),
                text(&args, "runId")?,
                text(&args, "status")?,
                opt::<String>(&args, "sessionId")?,
                opt::<String>(&args, "error")?,
                integer(&args, "now")?,
            )
            .await?,
        ),
        // --- pi configuration ----------------------------------------------
        "get_gui_settings" => bridge::get_gui_settings(),
        "set_gui_setting" => {
            bridge::set_gui_setting(text(&args, "key")?, required(&args, "value")?)
        }
        "list_provider_models" => {
            json(bridge::list_provider_models(text(&args, "provider")?).await?)
        }
        "list_provider_profiles" => json(bridge::list_provider_profiles().await?),
        "probe_provider_models" => json(
            bridge::probe_provider_models(
                text(&args, "provider")?,
                text(&args, "baseUrl")?,
                text(&args, "api")?,
                opt::<String>(&args, "apiKey")?,
                flag(&args, "authHeader")?,
                opt::<String>(&args, "modelsUrl")?,
            )
            .await?,
        ),
        "save_provider" => json(
            bridge::save_provider(
                text(&args, "provider")?,
                opt::<String>(&args, "name")?,
                text(&args, "baseUrl")?,
                opt::<String>(&args, "modelsUrl")?,
                text(&args, "api")?,
                opt::<String>(&args, "apiKey")?,
                flag(&args, "authHeader")?,
            )
            .await?,
        ),
        "delete_provider" => json(bridge::delete_provider(text(&args, "provider")?)?),
        "sync_provider_models" => {
            json(bridge::sync_provider_models(text(&args, "provider")?).await?)
        }
        "set_default_model" => json(
            bridge::set_default_model(text(&args, "provider")?, text(&args, "modelId")?)?,
        ),
        "get_project_trust_mode" => json(bridge::get_project_trust_mode()?),
        "set_project_trust_mode" => json(bridge::set_project_trust_mode(text(&args, "mode")?)?),
        "list_mcp_servers" => bridge::list_mcp_servers(),
        "save_mcp_server" => {
            bridge::save_mcp_server(text(&args, "name")?, required(&args, "config")?)
        }
        "delete_mcp_server" => bridge::delete_mcp_server(text(&args, "name")?),
        "mcp_config_location" => bridge::mcp_config_location(),
        "computer_use_key_status" => bridge::computer_use_key_status(),
        "save_computer_use_key" => bridge::save_computer_use_key(opt::<String>(&args, "apiKey")?),
        "computer_use_config" => bridge::computer_use_config(),
        "save_computer_use_config" => {
            bridge::save_computer_use_config(required(&args, "config")?)
        }
        "save_computer_use_cloudflare_token" => {
            bridge::save_computer_use_cloudflare_token(opt::<String>(&args, "token")?)
        }
        "test_computer_use_decision" => json(bridge::test_computer_use_decision().await?),
        "image_config" => bridge::image_config(),
        "save_image_config" => bridge::save_image_config(required(&args, "config")?),
        // The accessibility snapshot: still desktop-owned, but a paired phone is
        // allowed to read it because computer use is the feature that needs it.
        #[cfg(target_os = "macos")]
        "ax_observe" => json(
            ax::ax_observe(text(&args, "appName")?, number::<usize>(&args, "maxNodes")?).await?,
        ),
        other => Err(format!("命令 {other} 没有远端实现")),
    }
}

/// Look a payload key up by its Rust or its webview spelling.
///
/// Tauri converts `camelCase` payload keys to the Rust parameter names, so the
/// same command may arrive spelled either way depending on who sent it. The
/// difference between `sessionPath` and `session_path` is not worth a silent
/// `None`.
fn at<'a>(args: &'a Value, name: &str) -> Option<&'a Value> {
    args.get(name)
        .or_else(|| args.get(snake_case(name)))
        .or_else(|| args.get(camel_case(name)))
}

/// `session_path` → `sessionPath`.
fn camel_case(name: &str) -> String {
    name.split('_')
        .enumerate()
        .map(|(index, part)| {
            if index == 0 {
                return part.to_string();
            }
            let mut chars = part.chars();
            chars
                .next()
                .map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
                .unwrap_or_default()
        })
        .collect()
}

/// `sessionPath` → `session_path`.
fn snake_case(name: &str) -> String {
    let mut out = String::with_capacity(name.len() + 4);
    for (index, character) in name.chars().enumerate() {
        if character.is_uppercase() {
            if index > 0 {
                out.push('_');
            }
            out.extend(character.to_lowercase());
        } else {
            out.push(character);
        }
    }
    out
}

/// A required string argument.
fn text(args: &Value, name: &str) -> Result<String, String> {
    match at(args, name) {
        Some(Value::String(value)) => Ok(value.clone()),
        Some(_) => Err(format!("参数 {name} 必须是字符串")),
        None => Err(format!("缺少参数 {name}")),
    }
}

/// A required boolean argument.
fn flag(args: &Value, name: &str) -> Result<bool, String> {
    match at(args, name) {
        Some(Value::Bool(value)) => Ok(*value),
        Some(_) => Err(format!("参数 {name} 必须是布尔值")),
        None => Err(format!("缺少参数 {name}")),
    }
}

/// A required integer argument, in either JSON number or string form.
fn integer(args: &Value, name: &str) -> Result<i64, String> {
    let value = required::<i64>(args, name)?;
    Ok(value)
}

/// A required number argument of an exact width.
fn number<T: DeserializeOwned>(args: &Value, name: &str) -> Result<T, String> {
    required(args, name)
}

/// A required argument of any deserializable shape.
fn required<T: DeserializeOwned>(args: &Value, name: &str) -> Result<T, String> {
    let value = at(args, name).ok_or_else(|| format!("缺少参数 {name}"))?;
    serde_json::from_value(value.clone()).map_err(|error| format!("参数 {name} 无效：{error}"))
}

/// An optional argument; `null` and absence are the same thing.
fn opt<T: DeserializeOwned>(args: &Value, name: &str) -> Result<Option<T>, String> {
    match at(args, name) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => serde_json::from_value(value.clone())
            .map(Some)
            .map_err(|error| format!("参数 {name} 无效：{error}")),
    }
}

/// A required nested object, kept as JSON for the command's own typed reader.
fn args_of(args: &Value, name: &str) -> Result<Value, String> {
    at(args, name)
        .cloned()
        .ok_or_else(|| format!("缺少参数 {name}"))
}

/// Serialize a command's reply the way the local webview would have received it.
fn json<T: Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_allowlist_excludes_device_local_commands() {
        // A phone that could stop the Host would cut the branch it sits on, and
        // its own APK update is installed on the phone — never on the Mac.
        for excluded in [
            "runtime_environment",
            "splash_ready",
            "mobile_update_probe",
            "mobile_update_install",
            "remote_host_start",
            "remote_host_stop",
            "save_relay_settings",
            "set_keep_awake",
            "pi_connect",
        ] {
            assert!(!allows(excluded), "{excluded} 不应出现在远端白名单里");
        }
    }

    #[test]
    fn the_allowlist_reaches_the_workspace() {
        for included in [
            "list_dir",
            "read_text_file",
            "write_text_file",
            "git_changed_files",
            "git_commit",
            "git_push",
            "pty_spawn",
            "notes_upsert",
            "discover",
        ] {
            assert!(allows(included), "{included} 应该可以从手机端调用");
        }
    }

    #[test]
    fn arguments_are_read_in_both_spellings() {
        let args = serde_json::json!({"session_path": "/tmp/a", "baseUrl": "http://x", "cols": 80});
        assert_eq!(text(&args, "session_path").unwrap(), "/tmp/a");
        assert_eq!(text(&args, "sessionPath").unwrap(), "/tmp/a");
        assert_eq!(text(&args, "base_url").unwrap(), "http://x");
        assert_eq!(text(&args, "baseUrl").unwrap(), "http://x");
        assert_eq!(number::<u16>(&args, "cols").unwrap(), 80);
        // The inverse spelling only matters when the two differ at all.
        assert_eq!(snake_case("sessionPath"), "session_path");
        assert_eq!(camel_case("session_path"), "sessionPath");
        assert_eq!(snake_case("path"), "path");
    }

    #[test]
    fn a_missing_or_mistyped_argument_is_named() {
        let args = serde_json::json!({"path": 3});
        assert_eq!(text(&args, "path").unwrap_err(), "参数 path 必须是字符串");
        assert_eq!(text(&args, "nope").unwrap_err(), "缺少参数 nope");
        assert_eq!(opt::<usize>(&args, "limit").unwrap(), None);
        assert_eq!(opt::<usize>(&serde_json::json!({"limit": null}), "limit").unwrap(), None);
    }
}
