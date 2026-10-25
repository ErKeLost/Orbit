//! Quick composer: 一个从任何应用里唤起的轻量输入框。
//!
//! 它**不是**第二个 Pi 连接——那样每次唤起都要起一条会话，成本远超「随手写一句话」。
//! 这里的做法是：小窗口只负责收集文字，然后把它交给主窗口，让主窗口用**已经在跑**
//! 的连接把它送出去（`useQuickSend` 决定是送进当前会话，还是开一个后台标签页）。
//! 所以这个模块的全部工作是窗口和一次事件投递。
//!
//! 窗口在第一次唤起时才创建：不开的人不该为它付启动时间。

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

pub const QUICK_LABEL: &str = "quick-composer";
/// 主窗口收到这条事件后把文字送出去。
pub const QUICK_SEND_EVENT: &str = "orbit:quick-send";
/// 主窗口把自己当前的 cwd 广播给小窗，好让「发送到哪」有个默认值。
pub const QUICK_SCOPE_EVENT: &str = "orbit:quick-scope";

const WIDTH: f64 = 680.0;
const HEIGHT: f64 = 148.0;
/// 离屏幕顶部多远：够高到不挡菜单栏，够低到像「从上面掉下来的一行」。
const TOP: f64 = 96.0;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct QuickPayload {
    text: String,
    cwd: String,
}

fn build(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    let window = WebviewWindowBuilder::new(app, QUICK_LABEL, WebviewUrl::App("quick-composer.html".into()))
        .title("Orbit")
        .inner_size(WIDTH, HEIGHT)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(true)
        .visible(false)
        .focused(false)
        .build()
        .map_err(|error| error.to_string())?;
    // 无边框窗口没有标题栏，位置只能自己摆：水平居中，靠上。
    if let Ok(Some(monitor)) = window.current_monitor() {
        let size = monitor.size();
        let scale = monitor.scale_factor();
        let width = size.width as f64 / scale;
        let x = (width - WIDTH) / 2.0;
        let _ = window.set_position(tauri::PhysicalPosition::new(
            (x * scale) as i32,
            (TOP * scale) as i32,
        ));
    }
    // 点走焦点就收起：它是一次对话，不是一个面板。
    let handle = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Focused(false)) {
            if let Some(quick) = handle.get_webview_window(QUICK_LABEL) {
                let _ = quick.hide();
            }
        }
    });
    Ok(window)
}

fn quick_window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    match app.get_webview_window(QUICK_LABEL) {
        Some(window) => Ok(window),
        None => build(app),
    }
}

/// 唤起 / 收起。已经开着就收起，和全局快捷键的手感一致。
#[tauri::command(async)]
pub fn quick_toggle(app: AppHandle) -> Result<bool, String> {
    let window = quick_window(&app)?;
    let visible = window.is_visible().unwrap_or(false);
    if visible {
        window.hide().map_err(|error| error.to_string())?;
        return Ok(false);
    }
    // 主窗口的当前范围先同步过去，小窗打开时标题栏就是对的。
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.emit_to(QUICK_LABEL, QUICK_SCOPE_EVENT, ());
        let _ = main.set_focus();
    }
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(true)
}

#[tauri::command(async)]
pub fn quick_hide(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(QUICK_LABEL) {
        window.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// 把文字交给主窗口。投递成功就先收起小窗：用户已经表达完了，等结果的是主窗口。
#[tauri::command(async)]
pub fn quick_send(app: AppHandle, text: String, cwd: String) -> Result<(), String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Ok(());
    }
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "main window is not available".to_string())?;
    main.emit_to("main", QUICK_SEND_EVENT, QuickPayload { text, cwd })
        .map_err(|error| error.to_string())?;
    if let Some(quick) = app.get_webview_window(QUICK_LABEL) {
        let _ = quick.hide();
    }
    // 主窗口带起来：这条消息的结果要在看得见的地方。
    let _ = main.show();
    let _ = main.set_focus();
    Ok(())
}

/// 主窗口把自己当前的 cwd 报给小窗（小窗打开时不必再问 Rust）。
#[tauri::command(async)]
pub fn quick_scope(app: AppHandle, cwd: String) -> Result<(), String> {
    if let Some(quick) = app.get_webview_window(QUICK_LABEL) {
        let _ = quick.emit_to(QUICK_LABEL, QUICK_SCOPE_EVENT, cwd);
    }
    Ok(())
}
