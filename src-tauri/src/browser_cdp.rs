//! Authenticated, page-scoped CDP and browser management. Chromium renders
//! natively; this channel carries protocol messages only.
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{mpsc, Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, Webview};
use tauri_runtime_cef::{allocate_devtools_message_id, DevToolsProtocol, WebviewCefExt};
use tokio::sync::mpsc as channel;
use tungstenite::{
    handshake::server::{Request, Response},
    Message,
};

#[derive(Default)]
pub struct NativeCdp {
    routes: Mutex<HashMap<String, Arc<Route>>>,
    endpoint: Mutex<Option<(String, String)>>,
}
#[derive(Default)]
struct Route {
    transition: tokio::sync::Mutex<()>,
    observers: Mutex<Vec<channel::Sender<String>>>,
    pending: Mutex<HashMap<i32, mpsc::SyncSender<Value>>>,
}

fn ensure(app: &AppHandle, view: &Webview) -> Result<Arc<Route>, String> {
    let state = app.state::<NativeCdp>();
    let mut routes = state.routes.lock().map_err(|e| e.to_string())?;
    if let Some(route) = routes.get(view.label()) {
        return Ok(route.clone());
    }
    let route = Arc::new(Route::default());
    let events = route.clone();
    view.on_dev_tools_protocol(move |protocol| {
        if let DevToolsProtocol::Message(data) = protocol {
            if let Ok(message) = String::from_utf8(data) {
                if let Ok(value) = serde_json::from_str::<Value>(&message) {
                    if let Some(id) = value["id"].as_i64() {
                        if let Ok(mut pending) = events.pending.lock() {
                            if let Some(sender) = pending.remove(&(id as i32)) {
                                let _ = sender.try_send(value);
                                return;
                            }
                        }
                    }
                }
                if let Ok(mut listeners) = events.observers.lock() {
                    // An overloaded client is disconnected, never silently left
                    // waiting on replies whose events have been discarded.
                    listeners.retain(|listener| listener.try_send(message.clone()).is_ok());
                }
            }
        }
    })
    .map_err(|e| e.to_string())?;
    routes.insert(view.label().into(), route.clone());
    Ok(route)
}

pub fn forget(app: &AppHandle, label: &str) {
    if let Ok(mut routes) = app.state::<NativeCdp>().routes.lock() {
        if let Some(route) = routes.remove(label) {
            if let Ok(mut observers) = route.observers.lock() {
                observers.clear();
            }
            if let Ok(mut pending) = route.pending.lock() {
                pending.clear();
            }
        }
    }
}

pub fn connect(app: &AppHandle, tab: &str, owner: &str) -> Result<Value, String> {
    crate::browser_view::cdp_view(app, tab, owner)?;
    let state = app.state::<NativeCdp>();
    let endpoint = state.endpoint.lock().map_err(|e| e.to_string())?;
    let (url, token) = endpoint.as_ref().ok_or("原生 CDP 通道尚未就绪")?;
    Ok(json!({"url":format!("{url}/native"),"token":token,"tab":tab,"owner":owner}))
}

pub fn serve(app: AppHandle) {
    let result = (|| -> Result<_, String> {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let address = listener.local_addr().map_err(|e| e.to_string())?;
        let token = format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
        let url = format!("ws://{address}");
        let root = crate::browser::browser_dir()?;
        std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let path = root.join("native-host.json");
        let temp = root.join(format!("native-host-{}.tmp", uuid::Uuid::new_v4()));
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp).map_err(|e| e.to_string())?;
        file.write_all(
            json!({"version":1,"url":format!("{url}/control"),"token":token})
                .to_string()
                .as_bytes(),
        )
        .map_err(|e| e.to_string())?;
        // Windows rename cannot replace an existing file.
        #[cfg(windows)]
        let _ = std::fs::remove_file(&path);
        std::fs::rename(&temp, &path).map_err(|e| e.to_string())?;
        *app.state::<NativeCdp>()
            .endpoint
            .lock()
            .map_err(|e| e.to_string())? = Some((url, token.clone()));
        Ok((listener, token))
    })();
    let (listener, token) = match result {
        Ok(value) => value,
        Err(e) => {
            eprintln!("[native-cdp] {e}");
            return;
        }
    };
    tauri::async_runtime::spawn(async move {
        let Ok(listener) = tokio::net::TcpListener::from_std(listener) else {
            return;
        };
        while let Ok((stream, _)) = listener.accept().await {
            let app = app.clone();
            let token = token.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = connection(app, stream, &token).await {
                    eprintln!("[native-cdp] {error}");
                }
            });
        }
    });
}

#[allow(clippy::result_large_err)] // tungstenite fixes the handshake callback error type.
async fn connection(
    app: AppHandle,
    stream: tokio::net::TcpStream,
    token: &str,
) -> Result<(), String> {
    stream.set_nodelay(true).map_err(|e| e.to_string())?;
    let mut target = None;
    let handshake =
        tokio_tungstenite::accept_hdr_async(stream, |request: &Request, response: Response| {
            let url = tauri::Url::parse(&format!("http://127.0.0.1{}", request.uri())).ok();
            let params = url
                .as_ref()
                .map(|url| url.query_pairs().into_owned().collect::<HashMap<_, _>>())
                .unwrap_or_default();
            let tab = params.get("tab").cloned().unwrap_or_default();
            let owner = params.get("owner").cloned().unwrap_or_default();
            let control = url.as_ref().is_some_and(|url| url.path() == "/control");
            if params.get("token").map(String::as_str) != Some(token)
                || request.headers().contains_key("origin")
                || (!control && crate::browser_view::cdp_view(&app, &tab, &owner).is_err())
            {
                return Err(tauri::http::Response::builder()
                    .status(403)
                    .body(Some("Forbidden".into()))
                    .unwrap());
            }
            target = Some((control, tab, owner));
            Ok(response)
        });
    let mut ws = tokio::time::timeout(Duration::from_secs(5), handshake)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    let (control, tab, owner) = target.ok_or("Missing native page")?;
    if control {
        if let Some(Ok(Message::Text(raw))) =
            tokio::time::timeout(Duration::from_secs(5), ws.next())
                .await
                .map_err(|e| e.to_string())?
        {
            if raw.len() > 65536 {
                return Err("Browser request exceeds 64 KB".into());
            }
            let value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
            let result = tauri::async_runtime::spawn_blocking(move || {
                crate::browser_view::handle_request(&app, value)
            })
            .await
            .map_err(|e| e.to_string())?;
            let reply = match result {
                Ok(value) => json!({"ok":true,"result":value}),
                Err(error) => json!({"ok":false,"error":error}),
            };
            ws.send(Message::Text(reply.to_string().into()))
                .await
                .map_err(|e| e.to_string())?;
        }
        let _ = ws.close(None).await;
        return Ok(());
    }
    let view = crate::browser_view::cdp_view(&app, &tab, &owner)?;
    let route = ensure(&app, &view)?;
    let query_app = app.clone();
    let query_view = view.clone();
    let info = tauri::async_runtime::spawn_blocking(move || {
        command(
            &query_app,
            &query_view,
            "Target.getTargetInfo",
            json!({}),
            Duration::from_secs(5),
        )
    })
    .await
    .map_err(|e| e.to_string())??;
    let root = info["targetInfo"]["targetId"]
        .as_str()
        .ok_or("Missing native target identity")?
        .to_string();
    let mut targets = HashSet::from([root]);
    let mut sessions = HashSet::new();
    let (tx, mut rx) = channel::channel(512);
    {
        let _transition = route.transition.lock().await;
        route.observers.lock().map_err(|e| e.to_string())?.push(tx);
    }
    let mut ids = HashMap::<i32, (u64, Instant, bool)>::new();
    loop {
        tokio::select! {
            event = rx.recv() => {
                let Some(raw) = event else { break; };
                let Ok(mut value) = serde_json::from_str::<Value>(&raw) else { continue; };
                if let Some(id) = value["id"].as_i64() {
                    let Some((client, _, attaching)) = ids.remove(&(id as i32)) else { continue; };
                    if attaching { if let Some(session) = value["result"]["sessionId"].as_str() { sessions.insert(session.to_string()); } }
                    value["id"] = json!(client);
                } else if !value["method"].is_string() { continue; }
                if value["method"] == "Target.attachedToTarget" {
                    if let Some(target) = value["params"]["targetInfo"]["targetId"].as_str() { targets.insert(target.to_string()); }
                    if let Some(session) = value["params"]["sessionId"].as_str() { sessions.insert(session.to_string()); }
                }
                if value["method"] == "Target.detachedFromTarget" {
                    if let Some(session) = value["params"]["sessionId"].as_str() { sessions.remove(session); }
                    if let Some(target) = value["params"]["targetId"].as_str() { targets.remove(target); }
                }
                ws.send(Message::Text(value.to_string().into())).await.map_err(|e| e.to_string())?;
            }
            message = ws.next() => match message {
                Some(Ok(Message::Text(raw))) => {
                    if raw.len() > 1024 * 1024 { break; }
                    let mut value: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
                    let client = value["id"].as_u64().ok_or("CDP command requires id")?;
                    let foreign_target = value["params"]["targetId"].as_str().is_some_and(|target| !targets.contains(target));
                    let foreign_session = value["sessionId"].as_str().or(value["params"]["sessionId"].as_str()).is_some_and(|session| !sessions.contains(session));
                    if value["method"].as_str().is_none_or(outside_page) || foreign_target || foreign_session || value["params"].get("browserContextId").is_some() {
                        ws.send(Message::Text(json!({"id":client,"error":{"code":-32000,"message":"Command is outside this native page"}}).to_string().into())).await.map_err(|e| e.to_string())?;
                        continue;
                    }
                    if crate::browser_view::cdp_view(&app, &tab, value["orbitOwner"].as_str().unwrap_or(&owner)).is_err() {
                        ws.send(Message::Text(json!({"id":client,"error":{"code":-32000,"message":"Native page lease has been released"}}).to_string().into())).await.map_err(|e| e.to_string())?;
                        continue;
                    }
                    if let Some(object) = value.as_object_mut() { object.remove("orbitOwner"); }
                    let id = allocate_devtools_message_id().map_err(|e| e.to_string())?;
                    ids.retain(|_, (_, at, _)| at.elapsed() < Duration::from_secs(30));
                    if ids.len() >= 512 { break; }
                    ids.insert(id, (client, Instant::now(), value["method"] == "Target.attachToTarget"));
                    value["id"] = json!(id);
                    if let Err(error) = view.send_dev_tools_message(value.to_string().as_bytes()) {
                        ids.remove(&id);
                        ws.send(Message::Text(json!({"id":client,"error":{"code":-32000,"message":error.to_string()}}).to_string().into())).await.map_err(|e| e.to_string())?;
                    }
                }
                Some(Ok(Message::Ping(data))) => { ws.send(Message::Pong(data)).await.map_err(|e| e.to_string())?; }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            }
        }
    }
    let transition = route.transition.lock().await;
    drop(rx);
    let last_client = route
        .observers
        .lock()
        .map(|mut observers| {
            observers.retain(|sender| !sender.is_closed());
            observers.is_empty()
        })
        .unwrap_or(false);
    if last_client {
        // CEF exposes one DevTools agent per native page. Detach child targets
        // before acknowledging disconnect so a replacement Pi executor gets
        // fresh iframe attachment events instead of inheriting dead sessions.
        let cleanup_app = app.clone();
        let cleanup_view = view.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            for (method, params) in [
                (
                    "Target.setAutoAttach",
                    json!({"autoAttach":false,"waitForDebuggerOnStart":false,"flatten":true}),
                ),
                // CEF shares one native agent. Runtime.enable on a replacement
                // connection must replay existing default execution contexts.
                ("Runtime.disable", json!({})),
                ("Network.disable", json!({})),
                ("Log.disable", json!({})),
                ("Page.disable", json!({})),
            ] {
                let _ = command(
                    &cleanup_app,
                    &cleanup_view,
                    method,
                    params,
                    Duration::from_secs(2),
                );
            }
        })
        .await;
    }
    drop(transition);
    let _ = ws.close(None).await;
    Ok(())
}

fn outside_page(method: &str) -> bool {
    method.starts_with("Browser.")
        || (method.starts_with("Storage.") && !matches!(method, "Storage.getStorageKeyForFrame"))
        || [
            "Target.createTarget",
            "Target.createBrowserContext",
            "Target.getTargets",
            "Target.getBrowserContexts",
            "Target.attachToBrowserTarget",
            "Target.closeTarget",
            "Target.activateTarget",
            "Target.disposeBrowserContext",
            "Target.setDiscoverTargets",
            "Target.sendMessageToTarget",
            "Target.exposeDevToolsProtocol",
        ]
        .contains(&method)
}

/// Internal operations share one lifetime-bound observer. In particular, never
/// destroy a CEF observer registration from inside its own callback.
pub fn command(
    app: &AppHandle,
    view: &Webview,
    method: &str,
    params: Value,
    timeout: Duration,
) -> Result<Value, String> {
    let route = ensure(app, view)?;
    let id = allocate_devtools_message_id().map_err(|e| e.to_string())?;
    let (tx, rx) = mpsc::sync_channel(1);
    route
        .pending
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id, tx);
    let result = (|| {
        view.send_dev_tools_message(
            json!({"id":id,"method":method,"params":params})
                .to_string()
                .as_bytes(),
        )
        .map_err(|e| e.to_string())?;
        let value = rx.recv_timeout(timeout).map_err(|e| e.to_string())?;
        if value.get("error").is_some() {
            Err(value["error"].to_string())
        } else {
            Ok(value["result"].clone())
        }
    })();
    route.pending.lock().map_err(|e| e.to_string())?.remove(&id);
    result
}
