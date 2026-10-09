//! Automations: user-defined recurring agent runs.
//!
//! The data model, validation rules, claim semantics and run ledger follow
//! Orbit's `src-tauri/src/automations.rs`; only storage differs — Orbit
//! keeps automations in its SQLite session store, Orbit writes two JSON files
//! in the app-data directory (same JSON shape, so the UI is a direct port).

use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

pub(crate) const CHANGED: &str = "orbit:automations-changed";

const MAX_NAME: usize = 200;
const MAX_PROMPT: usize = 1_000_000;
const MAX_TRIGGERS: usize = 20;
const MAX_RUNS_PER_AUTOMATION: usize = 100;
const MAX_RUNS_STORED: usize = 2_000;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Automation {
    id: String,
    name: String,
    prompt: String,
    harness: String,
    model: String,
    #[serde(default)]
    model_settings: HashMap<String, String>,
    cwd: String,
    workspace_mode: String,
    #[serde(default)]
    worktree_cwd: String,
    #[serde(default)]
    session_folder_id: String,
    reuse_session: bool,
    runtime_mode: String,
    #[serde(default = "default_trigger_kind")]
    trigger_kind: String,
    #[serde(default)]
    trigger_event: String,
    schedule_kind: String,
    minute: i64,
    time: String,
    day_of_week: i64,
    #[serde(default)]
    triggers: Option<Vec<AutomationTrigger>>,
    missed_run_grace_minutes: i64,
    enabled: bool,
    next_run_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_run_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_run_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_run_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_session_id: Option<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationUpsert {
    id: String,
    name: String,
    prompt: String,
    harness: String,
    model: String,
    #[serde(default)]
    model_settings: HashMap<String, String>,
    cwd: String,
    workspace_mode: String,
    #[serde(default)]
    worktree_cwd: String,
    #[serde(default)]
    session_folder_id: String,
    #[serde(default)]
    reuse_session: bool,
    runtime_mode: String,
    #[serde(default = "default_trigger_kind")]
    trigger_kind: String,
    #[serde(default)]
    trigger_event: String,
    schedule_kind: String,
    minute: i64,
    time: String,
    day_of_week: i64,
    #[serde(default)]
    triggers: Option<Vec<AutomationTrigger>>,
    missed_run_grace_minutes: i64,
    #[serde(default = "default_true")]
    enabled: bool,
    next_run_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRun {
    id: String,
    automation_id: String,
    trigger: String,
    scheduled_for: i64,
    created_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    started_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    completed_at: Option<i64>,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    event_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    event_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    event: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    prompt: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationTrigger {
    #[serde(default)]
    id: String,
    kind: String,
    #[serde(default)]
    event: String,
    #[serde(default = "default_schedule_kind")]
    schedule_kind: String,
    #[serde(default)]
    minute: i64,
    #[serde(default = "default_time")]
    time: String,
    #[serde(default = "default_day_of_week")]
    day_of_week: i64,
    #[serde(default)]
    repos: Vec<String>,
    #[serde(default)]
    repo: String,
    #[serde(default)]
    branch: String,
    #[serde(default = "default_actor")]
    actor: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DueAutomationRun {
    automation: Automation,
    run: AutomationRun,
}

fn default_true() -> bool {
    true
}
fn default_trigger_kind() -> String {
    "time".into()
}
fn default_schedule_kind() -> String {
    "weekdays".into()
}
fn default_time() -> String {
    "09:00".into()
}
fn default_day_of_week() -> i64 {
    1
}
fn default_actor() -> String {
    "anyone".into()
}

fn store_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位 Orbit 应用目录：{error}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn automations_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(store_dir(app)?.join("automations.json"))
}

fn runs_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(store_dir(app)?.join("automation-runs.json"))
}

/// Write through a temporary file so a crash cannot leave a half-written store.
fn write_json<T: Serialize>(path: &PathBuf, value: &T) -> Result<(), String> {
    let body = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, path).map_err(|e| e.to_string())
}

fn read_json<T: for<'de> Deserialize<'de> + Default>(path: &PathBuf) -> T {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|body| serde_json::from_str(&body).ok())
        .unwrap_or_default()
}

fn load(app: &AppHandle) -> Result<Vec<Automation>, String> {
    Ok(read_json::<Vec<Automation>>(&automations_path(app)?))
}

fn load_runs(app: &AppHandle) -> Result<Vec<AutomationRun>, String> {
    Ok(read_json::<Vec<AutomationRun>>(&runs_path(app)?))
}

fn save(app: &AppHandle, automations: &[Automation]) -> Result<(), String> {
    write_json(&automations_path(app)?, &automations)
}

fn save_runs(app: &AppHandle, runs: &[AutomationRun]) -> Result<(), String> {
    let mut trimmed = runs.to_vec();
    // Keep the newest MAX_RUNS_STORED, per-automation history is trimmed separately.
    trimmed.sort_by_key(|a| std::cmp::Reverse(a.created_at));
    trimmed.truncate(MAX_RUNS_STORED);
    write_json(&runs_path(app)?, &trimmed)
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 120
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ':')
}

fn valid_time(value: &str) -> bool {
    let Some((hour, minute)) = value.split_once(':') else { return false };
    if hour.len() != 2 || minute.len() != 2 {
        return false;
    }
    let (Ok(hour), Ok(minute)) = (hour.parse::<u32>(), minute.parse::<u32>()) else { return false };
    hour < 24 && minute < 60
}

fn has_time_trigger(automation: &Automation) -> bool {
    match automation.triggers.as_ref() {
        Some(triggers) if !triggers.is_empty() => triggers.iter().any(|trigger| trigger.kind == "time"),
        _ => automation.trigger_kind == "time",
    }
}

fn validate_upsert(input: &AutomationUpsert) -> Result<(), String> {
    if !valid_id(&input.id) {
        return Err("Invalid automation id.".into());
    }
    if input.name.trim().is_empty() || input.name.len() > MAX_NAME {
        return Err("Automation name is required and must be under 200 characters.".into());
    }
    if input.prompt.trim().is_empty() || input.prompt.len() > MAX_PROMPT {
        return Err("Automation prompt is required.".into());
    }
    if input.cwd.trim().is_empty() {
        return Err("Choose a project for this automation.".into());
    }
    if !matches!(input.workspace_mode.as_str(), "current" | "worktree" | "existing") {
        return Err("Invalid automation workspace mode.".into());
    }
    if !matches!(
        input.runtime_mode.as_str(),
        "supervised" | "auto-accept-edits" | "auto" | "full-access"
    ) {
        return Err("Invalid automation run mode.".into());
    }
    if !matches!(input.trigger_kind.as_str(), "time" | "github" | "gitlab") {
        return Err("Invalid automation trigger.".into());
    }
    if !matches!(input.schedule_kind.as_str(), "hourly" | "daily" | "weekdays" | "weekly") {
        return Err("Invalid automation schedule.".into());
    }
    if !(0..=59).contains(&input.minute) || !(0..=6).contains(&input.day_of_week) || !valid_time(&input.time) {
        return Err("Invalid automation time.".into());
    }
    if !(0..=43_200).contains(&input.missed_run_grace_minutes) {
        return Err("Invalid missed-run grace period.".into());
    }
    if let Some(triggers) = input.triggers.as_ref() {
        if triggers.len() > MAX_TRIGGERS {
            return Err("Too many automation triggers.".into());
        }
    }
    Ok(())
}

fn new_run(automation_id: &str, trigger: &str, scheduled_for: i64, now: i64, prompt: &str) -> AutomationRun {
    AutomationRun {
        id: uuid::Uuid::new_v4().to_string(),
        automation_id: automation_id.into(),
        trigger: trigger.into(),
        scheduled_for,
        created_at: now,
        started_at: None,
        completed_at: None,
        status: "pending".into(),
        session_id: None,
        error: None,
        event_key: None,
        event_kind: None,
        event: None,
        prompt: Some(prompt.into()),
    }
}

fn apply_summary(automation: &mut Automation, run: &AutomationRun, now: i64) {
    automation.last_run_at = Some(now);
    automation.last_run_status = Some(run.status.clone());
    automation.last_run_error = run.error.clone();
    if run.session_id.is_some() {
        automation.last_session_id = run.session_id.clone();
    }
    automation.updated_at = now;
}

fn trim_history(runs: &mut Vec<AutomationRun>, automation_id: &str) {
    let mut mine: Vec<(String, i64)> = runs
        .iter()
        .filter(|run| run.automation_id == automation_id)
        .map(|run| (run.id.clone(), run.created_at))
        .collect();
    if mine.len() <= MAX_RUNS_PER_AUTOMATION {
        return;
    }
    // Keep the newest N by created_at; identity-based so index shifts cannot
    // drop the wrong row.
    mine.sort_by_key(|a| std::cmp::Reverse(a.1));
    let keep: std::collections::HashSet<String> = mine
        .into_iter()
        .take(MAX_RUNS_PER_AUTOMATION)
        .map(|(id, _)| id)
        .collect();
    runs.retain(|run| run.automation_id != automation_id || keep.contains(&run.id));
}

#[tauri::command]
pub async fn automations_list(app: AppHandle) -> Result<Vec<Automation>, String> {
    load(&app)
}

#[tauri::command]
pub async fn automations_upsert(app: AppHandle, input: AutomationUpsert, now: i64) -> Result<Automation, String> {
    validate_upsert(&input)?;
    if input.next_run_at <= now {
        return Err("The next run must be in the future.".into());
    }
    let mut automations = load(&app)?;
    let existing = automations.iter().position(|item| item.id == input.id);
    let created_at = existing
        .map(|index| automations[index].created_at)
        .unwrap_or(now);
    let last = existing.map(|index| automations[index].clone());
    let automation = Automation {
        id: input.id,
        name: input.name.trim().to_string(),
        prompt: input.prompt,
        harness: input.harness,
        model: input.model,
        model_settings: input.model_settings,
        cwd: input.cwd,
        workspace_mode: input.workspace_mode,
        worktree_cwd: input.worktree_cwd,
        session_folder_id: input.session_folder_id,
        reuse_session: input.reuse_session,
        runtime_mode: input.runtime_mode,
        trigger_kind: input.trigger_kind,
        trigger_event: input.trigger_event,
        schedule_kind: input.schedule_kind,
        minute: input.minute,
        time: input.time,
        day_of_week: input.day_of_week,
        triggers: input.triggers,
        missed_run_grace_minutes: input.missed_run_grace_minutes,
        enabled: input.enabled,
        next_run_at: input.next_run_at,
        last_run_at: last.as_ref().and_then(|item| item.last_run_at),
        last_run_status: last.as_ref().and_then(|item| item.last_run_status.clone()),
        last_run_error: last.as_ref().and_then(|item| item.last_run_error.clone()),
        last_session_id: last.as_ref().and_then(|item| item.last_session_id.clone()),
        created_at,
        updated_at: now,
    };
    match existing {
        Some(index) => automations[index] = automation.clone(),
        None => automations.push(automation.clone()),
    }
    save(&app, &automations)?;
    let _ = app.emit(CHANGED, ());
    Ok(automation)
}

#[tauri::command]
pub async fn automations_delete(app: AppHandle, automation_id: String) -> Result<(), String> {
    let mut automations = load(&app)?;
    automations.retain(|item| item.id != automation_id);
    save(&app, &automations)?;
    let mut runs = load_runs(&app)?;
    runs.retain(|run| run.automation_id != automation_id);
    save_runs(&app, &runs)?;
    let _ = app.emit(CHANGED, ());
    Ok(())
}

#[tauri::command]
pub async fn automation_runs_list(app: AppHandle, automation_id: String, limit: Option<usize>) -> Result<Vec<AutomationRun>, String> {
    let mut runs: Vec<AutomationRun> = load_runs(&app)?
        .into_iter()
        .filter(|run| run.automation_id == automation_id)
        .collect();
    runs.sort_by_key(|a| std::cmp::Reverse(a.created_at));
    runs.truncate(limit.unwrap_or(20).min(MAX_RUNS_PER_AUTOMATION));
    Ok(runs)
}

/// Runs left in `running`/`pending` by a crash become failures on startup.
#[tauri::command]
pub async fn automation_runs_recover(app: AppHandle, now: i64) -> Result<usize, String> {
    let mut runs = load_runs(&app)?;
    let mut automations = load(&app)?;
    let mut changed = 0usize;
    for run in runs.iter_mut() {
        if run.status != "running" && run.status != "pending" {
            continue;
        }
        run.status = "failed".into();
        run.completed_at = Some(now);
        run.error = Some("Orbit stopped before this run finished.".into());
        changed += 1;
        if let Some(automation) = automations.iter_mut().find(|item| item.id == run.automation_id) {
            apply_summary(automation, run, now);
        }
    }
    if changed > 0 {
        save_runs(&app, &runs)?;
        save(&app, &automations)?;
        let _ = app.emit(CHANGED, ());
    }
    Ok(changed)
}

/// Record a manual run and hand it back for the caller to launch.
#[tauri::command]
pub async fn automation_run_now(app: AppHandle, automation_id: String, now: i64) -> Result<AutomationRun, String> {
    let mut automations = load(&app)?;
    let Some(automation) = automations.iter_mut().find(|item| item.id == automation_id) else {
        return Err("Automation not found.".into());
    };
    let run = new_run(&automation_id, "manual", now, now, &automation.prompt);
    apply_summary(automation, &run, now);
    let mut runs = load_runs(&app)?;
    runs.push(run.clone());
    trim_history(&mut runs, &automation_id);
    save(&app, &automations)?;
    save_runs(&app, &runs)?;
    let _ = app.emit(CHANGED, ());
    Ok(run)
}

/// Claim one due occurrence. `expected_next_run_at` is the schedule slot the
/// frontend saw; the claim only succeeds if nothing else advanced it, and a
/// slot missed beyond the grace period is recorded as skipped rather than run.
#[tauri::command]
pub async fn automations_claim_due(
    app: AppHandle,
    automation_id: String,
    expected_next_run_at: i64,
    next_run_at: i64,
    now: i64,
) -> Result<Option<DueAutomationRun>, String> {
    if next_run_at <= expected_next_run_at {
        return Err("The following automation occurrence must advance the schedule.".into());
    }
    let mut automations = load(&app)?;
    let Some(index) = automations.iter().position(|item| item.id == automation_id) else {
        return Err("Automation not found.".into());
    };
    let current = automations[index].clone();
    if !current.enabled || current.next_run_at != expected_next_run_at || current.next_run_at > now {
        return Ok(None);
    }
    if !has_time_trigger(&current) {
        return Ok(None);
    }
    let mut automation = current;
    automation.next_run_at = next_run_at;
    let mut run = new_run(&automation_id, "scheduled", expected_next_run_at, now, &automation.prompt);
    let grace_ms = automation.missed_run_grace_minutes.saturating_mul(60_000);
    if now.saturating_sub(expected_next_run_at) > grace_ms {
        run.status = "skipped".into();
        run.completed_at = Some(now);
        run.error = Some("Missed the scheduled run beyond its grace period.".into());
    }
    apply_summary(&mut automation, &run, now);
    automations[index] = automation.clone();
    let mut runs = load_runs(&app)?;
    runs.push(run.clone());
    trim_history(&mut runs, &automation_id);
    save(&app, &automations)?;
    save_runs(&app, &runs)?;
    let _ = app.emit(CHANGED, ());
    Ok(Some(DueAutomationRun { automation, run }))
}

#[tauri::command]
pub async fn automation_run_update(
    app: AppHandle,
    run_id: String,
    status: String,
    session_id: Option<String>,
    error: Option<String>,
    now: i64,
) -> Result<AutomationRun, String> {
    if !matches!(
        status.as_str(),
        "pending" | "running" | "succeeded" | "failed" | "skipped" | "cancelled"
    ) {
        return Err("Invalid automation run status.".into());
    }
    let mut runs = load_runs(&app)?;
    let Some(index) = runs.iter().position(|run| run.id == run_id) else {
        return Err("Automation run not found.".into());
    };
    let mut run = runs[index].clone();
    run.status = status;
    if run.status == "running" && run.started_at.is_none() {
        run.started_at = Some(now);
    }
    if matches!(run.status.as_str(), "succeeded" | "failed" | "skipped" | "cancelled") {
        run.completed_at = Some(now);
    }
    if session_id.is_some() {
        run.session_id = session_id;
    }
    run.error = error.filter(|value| !value.trim().is_empty());
    let mut automations = load(&app)?;
    if let Some(automation) = automations.iter_mut().find(|item| item.id == run.automation_id) {
        apply_summary(automation, &run, now);
    }
    runs[index] = run.clone();
    save(&app, &automations)?;
    save_runs(&app, &runs)?;
    let _ = app.emit(CHANGED, ());
    Ok(run)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(id: &str) -> Automation {
        Automation {
            id: id.into(),
            name: "Audit".into(),
            prompt: "Look for regressions".into(),
            harness: "pi".into(),
            model: "".into(),
            model_settings: HashMap::new(),
            cwd: "/tmp/project".into(),
            workspace_mode: "current".into(),
            worktree_cwd: String::new(),
            session_folder_id: String::new(),
            reuse_session: false,
            runtime_mode: "supervised".into(),
            trigger_kind: "time".into(),
            trigger_event: String::new(),
            schedule_kind: "weekdays".into(),
            minute: 0,
            time: "09:00".into(),
            day_of_week: 1,
            triggers: None,
            missed_run_grace_minutes: 120,
            enabled: true,
            next_run_at: 1_000,
            last_run_at: None,
            last_run_status: None,
            last_run_error: None,
            last_session_id: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn validates_time_fields() {
        assert!(valid_time("09:30"));
        assert!(valid_time("23:59"));
        assert!(!valid_time("24:00"));
        assert!(!valid_time("9:30"));
    }

    #[test]
    fn legacy_automations_default_to_time_triggers() {
        assert!(has_time_trigger(&sample("a")));
    }

    #[test]
    fn trigger_lists_win_over_the_legacy_field() {
        let mut automation = sample("a");
        automation.triggers = Some(vec![AutomationTrigger {
            id: "t".into(),
            kind: "github".into(),
            event: "pull_request".into(),
            schedule_kind: "weekdays".into(),
            minute: 0,
            time: "09:00".into(),
            day_of_week: 1,
            repos: vec![],
            repo: String::new(),
            branch: String::new(),
            actor: "anyone".into(),
        }]);
        assert!(!has_time_trigger(&automation));
    }

    #[test]
    fn history_keeps_the_newest_runs() {
        let mut runs: Vec<AutomationRun> = (0..(MAX_RUNS_PER_AUTOMATION + 5) as i64)
            .map(|index| {
                let mut run = new_run("a", "scheduled", index, index, "p");
                run.created_at = index;
                run
            })
            .collect();
        trim_history(&mut runs, "a");
        assert_eq!(runs.len(), MAX_RUNS_PER_AUTOMATION);
        let oldest = runs.iter().map(|run| run.created_at).min().unwrap_or(-1);
        assert_eq!(oldest, 5, "kept {oldest} as the oldest run");
    }
}
