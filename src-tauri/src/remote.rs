//! LAN transport between an Orbit desktop Host and a Tauri mobile client.
//!
//! The transport mirrors Pi RPC values instead of translating individual Pi
//! event variants. This keeps the protocol forward compatible with the Pi
//! version bundled by Orbit.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL: &str = "orbit.remote.v1";

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RemoteTheme {
    #[default]
    Light,
    Dark,
}

#[derive(Deserialize)]
#[serde(tag = "name")]
enum RemoteHostOperation {
    #[serde(rename = "session.list")]
    SessionList { cwd: String },
    #[serde(rename = "project.files")]
    ProjectFiles { cwd: String },
    #[serde(rename = "session.turnDurations", rename_all = "camelCase")]
    SessionTurnDurations { session_path: String },
    #[serde(rename = "session.delete", rename_all = "camelCase")]
    SessionDelete { session_path: String },
    /// Add a project to the desktop's own registry.
    ///
    /// The registry lives in the desktop window (it owns the names, the icon
    /// and the extra roots), so the Host validates the path and asks that window
    /// to do the write. One writer, and the phone renders its published list.
    #[serde(rename = "project.add")]
    ProjectAdd { path: String },
    #[serde(rename = "project.forget")]
    ProjectForget { path: String },
    /// Open a project that is already listed on the desktop.
    ///
    /// The registry lists every project, but a phone can only attach to a
    /// project that has a live Pi connection. `project.add` already opens what
    /// it adds; this is the open for a project that is in the list but not
    /// running, so the phone can enter any project it can see.
    #[serde(rename = "project.open")]
    ProjectOpen { path: String },
    /// Which live connection serves a project, resolved by the Host.
    ///
    /// The Host owns path identity: it answers with the connection for an exact
    /// id, or for the canonical directory behind any spelling of that path (a
    /// trailing slash, a symlinked parent such as `/tmp` on macOS). A phone
    /// asks here instead of comparing paths itself, so a project the desktop
    /// has open stays attachable whatever spelling it arrived with.
    #[serde(rename = "connection.resolve")]
    ConnectionResolve { path: String },
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelaySettings {
    pub relay_url: String,
    pub host_key: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelaySettingsStatus {
    pub relay_url: String,
    pub has_host_key: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHostInfo {
    pub running: bool,
    pub mode: String,
    pub protocol: &'static str,
    pub host_id: String,
    pub bind_address: String,
    pub advertised_address: String,
    pub port: u16,
    pub token: String,
    pub pairing_uri: String,
    pub machine_name: String,
    pub connected_clients: usize,
    pub relay_url: Option<String>,
    pub relay_connected: bool,
}

#[cfg(desktop)]
mod desktop {
    use super::{RelaySettings, RelaySettingsStatus, RemoteHostInfo, RemoteTheme, PROTOCOL};
    use crate::bridge::Bridge;
    use crate::screen::{ScreenHost, ScreenSubscription};
    use aes_gcm::{
        aead::{rand_core::RngCore, Aead, OsRng, Payload},
        Aes256Gcm, KeyInit, Nonce,
    };
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    use futures_util::{SinkExt, StreamExt};
    use serde::{Deserialize, Serialize};
    use serde_json::{json, Value};
    use std::{
        collections::{HashMap, HashSet},
        fs,
        net::{IpAddr, SocketAddr, TcpListener, UdpSocket},
        path::PathBuf,
        pin::Pin,
        sync::{
            atomic::{AtomicBool, AtomicU64, Ordering},
            mpsc::{self, Receiver, SyncSender},
            Arc, Mutex,
        },
        thread,
        time::{Duration, Instant, SystemTime, UNIX_EPOCH},
    };
    use tauri::{AppHandle, Emitter, Manager, State};
    use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufStream};
    use tokio::net::TcpStream;
    use tokio_tungstenite::{
        accept_hdr_async, client_async,
        tungstenite::client::IntoClientRequest,
        tungstenite::handshake::server::ErrorResponse,
        tungstenite::Message, WebSocketStream,
    };
    use uuid::Uuid;

    const EVENT_BATCH_WINDOW: Duration = Duration::from_millis(16);
    /// Emitted into the desktop window when a phone asks to change the project
    /// registry: the window owns that list, so the Host asks rather than writes.
    pub const PROJECT_REQUEST_EVENT: &str = "orbit://projects/request";
    const EVENT_QUEUE_CAPACITY: usize = 4096;
    const CLIENT_QUEUE_CAPACITY: usize = 256;
    /// How often a connection task checks whether the host was asked to stop.
    ///
    /// Not a data path: reads, writes and frame wakeups are all events. This
    /// only bounds how long a shutdown takes to be noticed.
    const SHUTDOWN_CHECK_INTERVAL: Duration = Duration::from_millis(250);
    /// How long the Host waits for the client's encrypted auth frame after the
    /// WebSocket upgrade completes.
    const AUTH_TIMEOUT: Duration = Duration::from_secs(10);

    const SESSION_ID_LEN: usize = 16;
    const SEQ_LEN: usize = 8;
    const NONCE_LEN: usize = 12;

    #[derive(Clone, Deserialize, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct HostIdentity {
        host_id: String,
        token: String,
        relay_key: String,
        lan_port: Option<u16>,
    }

    struct Client {
        /// A tokio channel, because the senders are the connection tasks. The
        /// map stays a `std::sync::Mutex`: it is only ever held for a lookup,
        /// never across an await.
        sender: tokio::sync::mpsc::Sender<String>,
        projects: Arc<Mutex<HashSet<String>>>,
        /// The screen channel this connection is watching. Never read here:
        /// the send loops reach the subscription directly, and holding it on
        /// the client is what ties its lifetime to the connection. Dropping
        /// the client drops the subscription, which releases the capture
        /// stream once the idle grace period expires.
        #[allow(dead_code, reason = "owns the subscription for the connection's lifetime")]
        screen: Arc<ScreenSubscription>,
    }

    /// What a single connection is allowed to do. Passed by reference into
    /// request handling so the screen messages can reach their own handler
    /// without every other message having to know about them.
    struct Session {
        attached: Arc<Mutex<HashSet<String>>>,
        screen: Arc<ScreenSubscription>,
    }

    /// Every connected client, plus a signal for "somebody queued something".
    ///
    /// The signal exists because of how the relay path is shaped: one task owns
    /// one relay socket and serves *many* clients, so it cannot simply await its
    /// own queue the way a LAN connection does. Outbound work is queued by an
    /// arbitrary thread (a Pi event, a screen frame), and without a signal the
    /// relay would only notice it on the next socket message or heartbeat — up
    /// to fifteen seconds. `Notify` is the right primitive rather than a
    /// channel: `notify_one` stores a permit when no task is waiting, so a
    /// signal raised during the drain is not lost, and there is no capacity to
    /// manage.
    #[derive(Clone)]
    struct Clients {
        map: Arc<Mutex<HashMap<Uuid, Client>>>,
        work: Arc<tokio::sync::Notify>,
    }

    impl Clients {
        fn new() -> Self {
            Self {
                map: Arc::new(Mutex::new(HashMap::new())),
                work: Arc::new(tokio::sync::Notify::new()),
            }
        }
    }

    struct PiBroadcast {
        project: String,
        payload: Value,
    }

    struct RunningHost {
        info: RemoteHostInfo,
        stop: Arc<AtomicBool>,
        relay_connected: Arc<AtomicBool>,
        clients: Arc<Clients>,
        events: SyncSender<PiBroadcast>,
    }

    struct RelayClient {
        local_id: Uuid,
        attached: Arc<Mutex<HashSet<String>>>,
        incoming: tokio::sync::mpsc::Receiver<String>,
        screen: Arc<ScreenSubscription>,
        cipher: FrameCipher,
    }

    pub struct RemoteHost {
        running: Mutex<Option<RunningHost>>,
        theme: Mutex<RemoteTheme>,
        /// The desktop window's project registry, as last published by it.
        ///
        /// The window is the writer — it owns the names and the extra roots —
        /// so this is a publication, not a second copy to keep in step: a phone
        /// reads it from every snapshot, and the window refreshes it whenever
        /// the list changes.
        projects: Mutex<Vec<Value>>,
    }

    impl Default for RemoteHost {
        fn default() -> Self {
            Self {
                running: Mutex::new(None),
                theme: Mutex::new(RemoteTheme::default()),
                projects: Mutex::new(Vec::new()),
            }
        }
    }

    impl RemoteHost {
        fn info(&self) -> Option<RemoteHostInfo> {
            let slot = self.running.lock().ok()?;
            let host = slot.as_ref()?;
            let mut info = host.info.clone();
            info.connected_clients = host
                .clients
                .map
                .lock()
                .map(|clients| clients.len())
                .unwrap_or(0);
            info.relay_connected = host.relay_connected.load(Ordering::Acquire);
            Some(info)
        }

        fn theme(&self) -> RemoteTheme {
            self.theme.lock().map(|theme| *theme).unwrap_or_default()
        }

        fn set_theme(&self, theme: RemoteTheme) {
            let changed = self.theme.lock().is_ok_and(|mut current| {
                if *current == theme {
                    false
                } else {
                    *current = theme;
                    true
                }
            });
            if !changed {
                return;
            }
            let clients = self
                .running
                .lock()
                .ok()
                .and_then(|slot| slot.as_ref().map(|host| host.clients.clone()));
            if let Some(clients) = clients {
                broadcast_all(
                    &clients,
                    json!({"type":"host.theme","theme":theme,"serverTime":unix_millis()})
                        .to_string(),
                );
            }
        }

        pub fn stop(&self) {
            if let Ok(mut slot) = self.running.lock() {
                if let Some(host) = slot.take() {
                    host.stop.store(true, Ordering::Release);
                    if let Ok(mut clients) = host.clients.map.lock() {
                        clients.clear();
                    }
                }
            }
        }

        /// Whether the Host is serving right now.
        ///
        /// Asked by the macOS close handler, which must not let a window take a
        /// live Host — and with it every attached phone — down. Only that
        /// caller exists, hence the platform gate rather than a public accessor
        /// nothing else reads.
        #[cfg(target_os = "macos")]
        pub fn is_running(&self) -> bool {
            self.running.lock().is_ok_and(|slot| slot.is_some())
        }

        /// The project registry the desktop window last published.
        pub fn projects(&self) -> Vec<Value> {
            self.projects.lock().map(|list| list.clone()).unwrap_or_default()
        }

        /// Publish the registry and tell every connected phone about it.
        ///
        /// A phone that is looking at the rail is looking at this list, so a
        /// change the user makes on either side has to reach the other one
        /// without waiting for the next reconnect.
        pub fn set_projects(&self, projects: Vec<Value>) {
            if let Ok(mut list) = self.projects.lock() {
                *list = projects.clone();
            }
            let clients = self
                .running
                .lock()
                .ok()
                .and_then(|slot| slot.as_ref().map(|host| host.clients.clone()));
            if let Some(clients) = clients {
                broadcast_all(
                    &clients,
                    json!({"type":"host.projects","projects":projects,"serverTime":unix_millis()})
                        .to_string(),
                );
            }
        }

        pub fn publish(&self, project: &str, payload: &Value) {
            let Ok(slot) = self.running.lock() else {
                return;
            };
            let Some(host) = slot.as_ref() else { return };
            let _ = host.events.try_send(PiBroadcast {
                project: project.to_owned(),
                payload: payload.clone(),
            });
            if payload.get("type").and_then(Value::as_str) == Some("response")
                && payload.get("success").and_then(Value::as_bool) == Some(true)
                && matches!(
                    payload.get("command").and_then(Value::as_str),
                    Some("new_session" | "switch_session")
                )
            {
                let _ = host.events.try_send(PiBroadcast {
                project: project.to_owned(),
                payload: serde_json::json!({"type":"connection.invalidated","project":project,"command":payload.get("command").and_then(Value::as_str).unwrap_or_default()}),
            });
            }
        }

        pub fn publish_connection_closed(&self, project: &str) {
            let clients = self
                .running
                .lock()
                .ok()
                .and_then(|slot| slot.as_ref().map(|host| host.clients.clone()));
            if let Some(clients) = clients {
                broadcast(
                    &clients,
                    project,
                    json!({"type":"connection.closed","project":project}).to_string(),
                );
            }
        }

        /// Send one frame to every attached client.
        ///
        /// Terminal output is the reason this exists. It has no project to be
        /// scoped to, so it cannot go through `publish`, and `pty_term` already
        /// coalesces its reads before emitting, so there is nothing left for the
        /// Pi event batcher to win: a frame per chunk is the same shape the
        /// desktop window already receives.
        pub fn publish_all(&self, frame: Value) {
            let clients = self
                .running
                .lock()
                .ok()
                .and_then(|slot| slot.as_ref().map(|host| host.clients.clone()));
            if let Some(clients) = clients {
                broadcast_all(&clients, frame.to_string());
            }
        }
    }

    impl Drop for RemoteHost {
        fn drop(&mut self) {
            self.stop();
        }
    }

    fn unix_millis() -> u128 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    }

    fn advertised_address(bound: IpAddr) -> String {
        if !bound.is_unspecified() {
            return bound.to_string();
        }
        // Prefer the route to the LAN gateway. A UDP socket connected to a
        // public address can select a Clash/TUN 198.18.x.x interface, which
        // is not reachable from a phone on the local Wi-Fi network.
        if let Ok(output) = std::process::Command::new("route")
            .args(["-n", "get", "default"])
            .output()
        {
            let text = String::from_utf8_lossy(&output.stdout);
            if let Some(interface) = text
                .lines()
                .find_map(|line| line.trim().strip_prefix("interface: ").map(str::trim))
            {
                if let Ok(address) = std::process::Command::new("ipconfig")
                    .args(["getifaddr", interface])
                    .output()
                {
                    let value = String::from_utf8_lossy(&address.stdout).trim().to_string();
                    if value.parse::<IpAddr>().is_ok() && !value.starts_with("198.18.") {
                        return value;
                    }
                }
            }
        }
        UdpSocket::bind("0.0.0.0:0")
            .and_then(|socket| {
                socket.connect("192.168.1.1:80")?;
                socket.local_addr()
            })
            .map(|address| address.ip().to_string())
            .ok()
            .filter(|address| !address.starts_with("198.18."))
            .unwrap_or_else(|| "127.0.0.1".into())
    }

    fn relay_settings_path() -> Result<PathBuf, String> {
        Ok(crate::bridge::agent_dir()?.join("orbit-relay.json"))
    }

    fn host_identity_path() -> Result<PathBuf, String> {
        Ok(crate::bridge::agent_dir()?.join("orbit-host-identity.json"))
    }

    fn valid_host_id(value: &str) -> bool {
        value.len() >= 8 && value.len() <= 80 && Uuid::parse_str(value).is_ok()
    }

    fn valid_secret(value: &str) -> bool {
        (16..=256).contains(&value.len())
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    }

    fn valid_host_identity(identity: &HostIdentity) -> bool {
        valid_host_id(&identity.host_id)
            && valid_secret(&identity.token)
            && identity.relay_key.len() == 43
            && identity
                .relay_key
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            && identity.lan_port.is_none_or(|port| port > 0)
    }

    fn save_host_identity(identity: &HostIdentity) -> Result<(), String> {
        let path = host_identity_path()?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::write(
            &path,
            serde_json::to_vec_pretty(identity).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }

    fn load_host_identity() -> Result<HostIdentity, String> {
        let path = host_identity_path()?;
        if let Ok(contents) = fs::read_to_string(&path) {
            if let Ok(identity) = serde_json::from_str::<HostIdentity>(&contents) {
                if valid_host_identity(&identity) {
                    return Ok(identity);
                }
            }
        }
        let identity = HostIdentity {
            host_id: Uuid::new_v4().to_string(),
            token: Uuid::new_v4().simple().to_string(),
            relay_key: random_secret(32),
            lan_port: None,
        };
        save_host_identity(&identity)?;
        Ok(identity)
    }

    fn load_relay_settings() -> Result<RelaySettings, String> {
        let path = relay_settings_path()?;
        let settings = serde_json::from_str::<RelaySettings>(
            &fs::read_to_string(path).map_err(|_| "尚未配置 Orbit Relay".to_string())?,
        )
        .map_err(|_| "Orbit Relay 配置无效".to_string())?;
        validate_relay_settings(&settings)?;
        Ok(settings)
    }

    fn validate_relay_settings(settings: &RelaySettings) -> Result<(), String> {
        let relay = tungstenite::http::Uri::try_from(settings.relay_url.as_str())
            .map_err(|_| "Relay 地址无效".to_string())?;
        if relay.scheme_str() != Some("wss") {
            return Err("Relay 地址必须以 wss:// 开头".into());
        }
        if !is_url_safe_secret(&settings.host_key) {
            return Err("Host Key 必须是至少 32 位的 URL 安全字符串".into());
        }
        Ok(())
    }

    fn is_url_safe_secret(value: &str) -> bool {
        (32..=256).contains(&value.len())
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    }

    fn write_relay_settings(settings: &RelaySettings) -> Result<(), String> {
        validate_relay_settings(settings)?;
        let path = relay_settings_path()?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::write(
            &path,
            serde_json::to_vec_pretty(settings).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }

    fn random_secret(bytes: usize) -> String {
        let mut value = vec![0_u8; bytes];
        OsRng.fill_bytes(&mut value);
        URL_SAFE_NO_PAD.encode(value)
    }

    fn pairing_uri(address: &str, port: u16, token: &str, key: &str, host_id: &str) -> String {
        format!("orbit://pair?host={address}&port={port}&token={token}&key={key}&hostId={host_id}&protocol={PROTOCOL}")
    }

    fn relay_pairing_uri(relay_url: &str, host_id: &str, token: &str, key: &str) -> String {
        format!(
            "orbit://pair?relay={}&hostId={host_id}&token={token}&key={key}&protocol={PROTOCOL}",
            percent_encode(relay_url)
        )
    }

    fn auto_pairing_uri(
        address: &str,
        port: u16,
        relay_url: &str,
        host_id: &str,
        token: &str,
        key: &str,
    ) -> String {
        format!(
            "orbit://pair?host={address}&port={port}&relay={}&hostId={host_id}&token={token}&key={key}&protocol={PROTOCOL}",
            percent_encode(relay_url)
        )
    }

    fn percent_encode(value: &str) -> String {
        value.bytes().fold(String::new(), |mut encoded, byte| {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
                encoded.push(byte as char);
            } else {
                encoded.push_str(&format!("%{byte:02X}"));
            }
            encoded
        })
    }

    fn relay_host(relay_url: &str) -> String {
        tungstenite::http::Uri::try_from(relay_url)
            .ok()
            .and_then(|uri| uri.host().map(str::to_owned))
            .unwrap_or_else(|| relay_url.to_owned())
    }

    fn machine_name() -> String {
        if let Ok(value) = std::env::var("COMPUTERNAME") {
            if !value.trim().is_empty() {
                return value.trim().to_owned();
            }
        }
        if let Ok(output) = std::process::Command::new("scutil")
            .args(["--get", "LocalHostName"])
            .output()
        {
            let value = String::from_utf8_lossy(&output.stdout).trim().to_owned();
            if !value.is_empty() {
                return value;
            }
        }
        std::env::var("HOSTNAME")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "Orbit Desktop".into())
    }

    /// Deliver at most one pending screen frame on this connection.
    ///
    /// Returns `false` when the socket is gone and the caller should stop. The
    /// envelope is built once per frame and shared by every subscriber, so only
    /// the (optional) encryption runs per connection.
    async fn send_screen_frame<S>(
        socket: &mut WebSocketStream<S>,
        subscription: &ScreenSubscription,
        cipher: &mut FrameCipher,
    ) -> bool
    where
        S: AsyncRead + AsyncWrite + Unpin,
    {
        let Some(frame) = subscription.poll() else {
            return true;
        };
        let Ok(payload) = cipher.encrypt(&frame.envelope) else {
            return false;
        };
        socket.send(Message::text(payload)).await.is_ok()
    }

    /// 单条事件在切帧前允许占用的上限。超过它的事件不再丢弃，而是切成
    /// `pi.event.chunk` 多帧、由手机端拼回原始 JSON。
    ///
    /// 丢弃是条死路：手机等的可能就是这条 `response`（几百条消息的会话，
    /// `get_messages` 的响应就是几 MB），它永远不会到，手机只能超时，而桌面
    /// 端看起来一切正常。
    const MAX_EVENT_PAYLOAD_BYTES: usize = 4 * 1024 * 1024;
    /// 切片大小。跟批次预算同一个量级：任何一帧都不该把 relay 或手机的上行堵住。
    const EVENT_CHUNK_BYTES: usize = 512 * 1024;
    /// 单帧批次的字节预算。超过就拆成多帧，保证任何一帧都不会卡住 relay。
    const MAX_EVENT_BATCH_BYTES: usize = 768 * 1024;
    /// 一片事件切到底也不该超过的量：再大就不是“慢”，而是手机存不下。
    const MAX_CHUNKED_PAYLOAD_BYTES: usize = 48 * 1024 * 1024;
    /// 切片编号。同一个 payload 的每一片共用一个编号，手机按 `project + id` 归并。
    static CHUNK_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    fn flush_batch(
        frames: &mut Vec<String>,
        project: &str,
        batch: &mut Vec<Value>,
        batch_bytes: &mut usize,
    ) {
        if batch.is_empty() {
            return;
        }
        frames.push(
            json!({"type":"pi.events","project":project,"payloads":std::mem::take(batch)})
                .to_string(),
        );
        *batch_bytes = 0;
    }

    /// 把一批 Pi 事件变成要发的帧。
    ///
    /// 小事件按 `MAX_EVENT_BATCH_BYTES` 打包成 `pi.events`；大到一帧装不下的事件
    /// 切成 `pi.event.chunk`。两者混在同一批里也安全：切片帧自带编号，手机不会
    /// 把它当成 Pi 事件本身。
    fn event_frames(project: &str, payloads: Vec<Value>) -> Vec<String> {
        let mut frames: Vec<String> = Vec::new();
        let mut batch: Vec<Value> = Vec::new();
        let mut batch_bytes = 0usize;
        for payload in payloads {
            let bytes = serde_json::to_vec(&payload)
                .map(|encoded| encoded.len())
                .unwrap_or(usize::MAX);
            if bytes > MAX_EVENT_PAYLOAD_BYTES {
                flush_batch(&mut frames, project, &mut batch, &mut batch_bytes);
                match split_payload(project, &payload) {
                    Some(chunks) => frames.extend(chunks),
                    None => {
                        log::warn!("丢弃无法切片的 Pi 事件（{bytes} 字节）");
                    }
                }
                continue;
            }
            if batch_bytes + bytes > MAX_EVENT_BATCH_BYTES && !batch.is_empty() {
                flush_batch(&mut frames, project, &mut batch, &mut batch_bytes);
            }
            batch_bytes += bytes;
            batch.push(payload);
        }
        flush_batch(&mut frames, project, &mut batch, &mut batch_bytes);
        frames
    }

    /// 一帧装不下的事件，切成手机可以拼回去的多帧。
    ///
    /// 切的是序列化后的 JSON 文本，并且只落在字符边界上，所以手机把片段顺序拼起来
    /// 就是原封不动的那条 payload。超过 `MAX_CHUNKED_PAYLOAD_BYTES` 的，如果是一
    /// 条 `response`，就换一条明确的失败响应——让手机拿到“太大”，而不是干等超时。
    fn split_payload(project: &str, payload: &Value) -> Option<Vec<String>> {
        let text = serde_json::to_string(payload).ok()?;
        if text.len() > MAX_CHUNKED_PAYLOAD_BYTES {
            return oversized_response(payload, text.len())
                .map(|frame| vec![frame.to_string()]);
        }
        let id = CHUNK_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let mut parts: Vec<&str> = Vec::new();
        let mut start = 0usize;
        while start < text.len() {
            let mut end = (start + EVENT_CHUNK_BYTES).min(text.len());
            while end < text.len() && !text.is_char_boundary(end) {
                end += 1;
            }
            parts.push(&text[start..end]);
            start = end;
        }
        let total = parts.len();
        Some(
            parts
                .into_iter()
                .enumerate()
                .map(|(index, data)| {
                    json!({
                        "type": "pi.event.chunk",
                        "project": project,
                        "id": id,
                        "index": index,
                        "total": total,
                        "data": data,
                    })
                    .to_string()
                })
                .collect(),
        )
    }

    /// 太大、连切片都不要发的那条响应，换成的失败响应。
    fn oversized_response(payload: &Value, bytes: usize) -> Option<Value> {
        if payload.get("type").and_then(Value::as_str) != Some("response") {
            return None;
        }
        let id = payload.get("id")?.clone();
        let command = payload
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or("请求")
            .to_owned();
        Some(json!({
            "type": "response",
            "id": id,
            "command": command,
            "success": false,
            "error": format!(
                "响应过大（{} MB），超过手机链路的上限；在电脑端查看，或先压缩上下文",
                bytes / (1024 * 1024)
            ),
        }))
    }

    fn broadcast(clients: &Clients, project: &str, frame: String) {
        let Ok(mut map) = clients.map.lock() else {
            return;
        };
        let mut queued = false;
        map.retain(|_, client| {
            let subscribed = client
                .projects
                .lock()
                .is_ok_and(|projects| projects.contains(project));
            if !subscribed {
                return true;
            }
            // A full queue is a slow client: dropping the connection is the
            // same policy the blocking version had, and it is what bounds
            // memory when a phone stops reading.
            match client.sender.try_send(frame.clone()) {
                Ok(()) => {
                    queued = true;
                    true
                }
                Err(_) => false,
            }
        });
        if queued {
            clients.work.notify_one();
        }
    }

    fn broadcast_all(clients: &Clients, frame: String) {
        let Ok(mut map) = clients.map.lock() else {
            return;
        };
        let mut queued = false;
        map.retain(|_, client| {
            if client.sender.try_send(frame.clone()).is_ok() {
                queued = true;
                true
            } else {
                false
            }
        });
        if queued {
            clients.work.notify_one();
        }
    }

    fn broadcast_loop(receiver: Receiver<PiBroadcast>, clients: Arc<Clients>, stop: Arc<AtomicBool>) {
        while !stop.load(Ordering::Acquire) {
            let first = match receiver.recv_timeout(Duration::from_millis(100)) {
                Ok(event) => event,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            };
            let deadline = Instant::now() + EVENT_BATCH_WINDOW;
            let mut projects = HashMap::<String, Vec<Value>>::new();
            projects
                .entry(first.project)
                .or_default()
                .push(first.payload);
            while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
                match receiver.recv_timeout(remaining) {
                    Ok(event) => projects
                        .entry(event.project)
                        .or_default()
                        .push(event.payload),
                    Err(mpsc::RecvTimeoutError::Timeout) => break,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }
            for (project, payloads) in projects {
                for frame in event_frames(&project, payloads) {
                    broadcast(&clients, &project, frame);
                }
            }
        }
    }

    fn websocket_path(uri: &tungstenite::http::Uri) -> bool {
        uri.path() == "/ws"
    }

    fn rejected() -> ErrorResponse {
        tungstenite::http::Response::builder()
            .status(tungstenite::http::StatusCode::UNAUTHORIZED)
            .body(Some("Orbit pairing token is required".into()))
            .expect("static HTTP response")
    }

    fn looks_like_websocket(head: &[u8]) -> bool {
        String::from_utf8_lossy(head).to_ascii_lowercase().contains("upgrade: websocket")
    }

    /// The plain-HTTP answer, kept because `curl host:port` is how a person
    /// checks whether the Host is listening at all.
    fn status_response() -> String {
        let body = json!({"service":"Orbit Host","protocol":PROTOCOL,"running":true}).to_string();
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(), body
        )
    }

    fn response(request_id: Option<&str>, result: Result<Value, String>) -> String {
        match result {
            Ok(result) => {
                json!({"type":"remote.result","requestId":request_id,"ok":true,"result":result})
                    .to_string()
            }
            Err(error) => {
                json!({"type":"remote.result","requestId":request_id,"ok":false,"error":error})
                    .to_string()
            }
        }
    }

    async fn run_operation(
        app: &AppHandle,
        operation: super::RemoteHostOperation,
    ) -> Result<Value, String> {
        match operation {
            super::RemoteHostOperation::SessionList { cwd } => {
                crate::bridge::list_sessions(app.clone(), cwd).await
            }
            super::RemoteHostOperation::ProjectFiles { cwd } => {
                crate::bridge::list_project_files(cwd).await
            }
            super::RemoteHostOperation::SessionTurnDurations { session_path } => {
                crate::bridge::session_turn_durations(app.clone(), session_path).await
            }
            super::RemoteHostOperation::SessionDelete { session_path } => {
                crate::bridge::delete_session(session_path)
                    .await
                    .map(|()| Value::Null)
            }
            super::RemoteHostOperation::ProjectAdd { path } => {
                request_project(app, "add", path)
            }
            super::RemoteHostOperation::ProjectOpen { path } => {
                // Already open: answer with the connection in this round trip.
                // The window would only re-select it, and the phone would then
                // poll for something that already exists — that poll is where a
                // path spelling the phone could not match itself used to time
                // out and dead-end the tap.
                let connection = connection_for(app, &path);
                if !connection.is_null() {
                    return Ok(connection);
                }
                request_project(app, "open", path)
            }
            super::RemoteHostOperation::ProjectForget { path } => {
                request_project(app, "forget", path)
            }
            super::RemoteHostOperation::ConnectionResolve { path } => {
                Ok(connection_for(app, &path))
            }
        }
    }

    /// One connection as the phone receives it, or `null` when nothing serves `path`.
    fn connection_for(app: &AppHandle, path: &str) -> Value {
        match app.state::<crate::bridge::Bridge>().resolve(path) {
            Some((id, cwd)) => json!({"id": id, "cwd": cwd}),
            None => Value::Null,
        }
    }

    /// Hand a project change to the desktop window, which owns the registry.
    ///
    /// The Host checks that an added or opened path exists (the phone's picker
    /// is a directory listing, so a typo is possible) and then emits the
    /// request; the window adds, opens or forgets it and republishes the list,
    /// which comes back to every phone as `host.projects`. The phone never
    /// receives a success it cannot see in that list.
    fn request_project(app: &AppHandle, action: &str, path: String) -> Result<Value, String> {
        let target = crate::git::expand_home(&path);
        if action == "add" || action == "open" {
            let meta = std::fs::metadata(&target)
                .map_err(|_| format!("{} 不存在", target.display()))?;
            if !meta.is_dir() {
                return Err(format!("{} 不是文件夹", target.display()));
            }
        }
        let resolved = target.to_string_lossy().into_owned();
        app.emit(
            PROJECT_REQUEST_EVENT,
            json!({"action": action, "path": resolved}),
        )
        .map_err(|error| error.to_string())?;
        Ok(json!({"action": action, "path": resolved}))
    }

    /// 可能长时间占用 relay 任务的请求。
    ///
    /// `host.operation` 里最重的 `session.list` 要把项目的全部会话 JSONL 过一
    /// 遍，跑了几天的项目上这是几十 MB 的磁盘读取；内联等待会把屏幕帧、心跳
    /// 和其他客户端一起卡住，所以这类请求交给后台任务处理。
    fn is_slow_request(raw: &str) -> bool {
        serde_json::from_str::<Value>(raw)
            .ok()
            .and_then(|value| {
                value
                    .get("type")
                    .and_then(Value::as_str)
                    .map(|kind| kind == "host.operation")
            })
            .unwrap_or(false)
    }

    /// Handle one client message.
    ///
    /// Returns `None` when the message expects no reply at all. That is not a
    /// micro-optimisation: input events arrive continuously while a finger is
    /// on the screen, and a reply for each one would consume the same socket
    /// that the acknowledge would travel on.
    async fn handle_request(app: &AppHandle, raw: &str, session: &Session) -> Option<String> {
        let request = match serde_json::from_str::<Value>(raw) {
            Ok(request) => request,
            Err(_) => {
                return Some(
                    json!({"type":"remote.error","error":"消息不是有效 JSON"}).to_string(),
                );
            }
        };
        // Owned so `request` can move into the host handler below.
        let request_id = request
            .get("requestId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        // The screen channel owns its own message namespace and a capture
        // pipeline, so it answers before the general request match.
        if let Some(result) =
            crate::screen::handle_request(&app.state::<ScreenHost>(), &session.screen, &request)
        {
            if request_id.is_none() && result.is_ok() {
                return None;
            }
            return Some(response(request_id.as_deref(), result));
        }
        Some(handle_host_request(app, request, session, request_id.as_deref()).await)
    }

    async fn handle_host_request(
        app: &AppHandle,
        request: Value,
        session: &Session,
        request_id: Option<&str>,
    ) -> String {
        match request.get("type").and_then(Value::as_str) {
            Some("host.ping") => {
                json!({"type":"host.pong","requestId":request_id,"serverTime":unix_millis()})
                    .to_string()
            }
            Some("host.snapshot") => response(
                request_id,
                Ok(json!({
                    "protocol": PROTOCOL,
                    "serverTime": unix_millis(),
                    "theme": app.state::<RemoteHost>().theme(),
                    "machineName": app.state::<RemoteHost>().info().map(|info| info.machine_name).unwrap_or_else(|| "Orbit Desktop".into()),
                    "connections": app.state::<Bridge>().connections(),
                    "projects": app.state::<RemoteHost>().projects(),
                    // What this Host will answer. Advertised rather than
                    // assumed: the phone routes a command here only when it is
                    // on the list, so an older APK against a newer desktop
                    // keeps using whatever it does know.
                    "commands": crate::remote_ops::REMOTE_COMMANDS,
                })),
            ),
            Some("host.invoke") => {
                let Some(command) = request.get("command").and_then(Value::as_str) else {
                    return json!({"type":"remote.error","requestId":request_id,"error":"host.invoke 缺少 command"}).to_string();
                };
                let args = request.get("args").cloned().unwrap_or(Value::Null);
                response(request_id, crate::remote_ops::dispatch(app, command, args).await)
            }
            Some("host.operation") => {
                let operation = request
                    .get("operation")
                    .cloned()
                    .ok_or_else(|| "host.operation 缺少 operation".to_string())
                    .and_then(|value| {
                        serde_json::from_value::<super::RemoteHostOperation>(value)
                            .map_err(|_| "host.operation 无效".to_string())
                    });
                let result = match operation {
                    Ok(operation) => run_operation(app, operation).await,
                    Err(error) => Err(error),
                };
                response(request_id, result)
            }
            Some("connection.attach") => {
                let Some(connection_id) = request
                    .get("connectionId")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                else {
                    return json!({"type":"remote.error","requestId":request_id,"error":"connection.attach 缺少 connectionId"}).to_string();
                };
                let connection = app
                    .state::<Bridge>()
                    .connections()
                    .into_iter()
                    .find(|connection| connection["id"].as_str() == Some(connection_id));
                if connection.is_some() {
                    if let Ok(mut projects) = session.attached.lock() {
                        projects.clear();
                        projects.insert(connection_id.to_owned());
                    }
                }
                response(
                    request_id,
                    connection.ok_or_else(|| "桌面连接不存在或已经关闭".into()),
                )
            }
            Some("pi.command") => {
                let Some(project) = request
                    .get("project")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                else {
                    return json!({"type":"remote.error","requestId":request_id,"error":"pi.command 缺少 project"}).to_string();
                };
                let Some(command) = request.get("command").filter(|value| {
                    value.is_object() && value.get("type").and_then(Value::as_str).is_some()
                }) else {
                    return json!({"type":"remote.error","requestId":request_id,"error":"pi.command 缺少有效 command"}).to_string();
                };
                if !session
                    .attached
                    .lock()
                    .is_ok_and(|projects| projects.contains(project))
                {
                    return json!({"type":"remote.error","requestId":request_id,"error":"请先附着桌面 connection"}).to_string();
                }
                response(
                    request_id,
                    app.state::<Bridge>()
                        .send(project, command.clone())
                        .map(|()| Value::Null),
                )
            }
            _ => json!({"type":"remote.error","requestId":request_id,"error":"不支持的远程消息"})
                .to_string(),
        }
    }

    /// Serve one LAN connection.
    ///
    /// Async so the socket can be read and written at the same time. The
    /// blocking version had to poll `read` on a timer to notice outbound work,
    /// which put a floor under the latency of *everything* the phone receives —
    /// frames, thinking tokens, and input replies alike. Here each source of
    /// work is an event: a queued message, an incoming frame, a published screen
    /// frame, or the shutdown flag.
    async fn client_loop(
        app: AppHandle,
        stream: TcpStream,
        token: String,
        clients: Arc<Clients>,
        stop: Arc<AtomicBool>,
        host_id: String,
        encryption_key: Arc<[u8; 32]>,
    ) {
        // Peek at the request without consuming it: a plain HTTP request gets
        // the status page, and a real upgrade is handed to the library's
        // handshake with its bytes still buffered. `BufStream` is what makes
        // that possible — it implements both directions.
        let mut stream = BufStream::new(stream);
        match stream.fill_buf().await {
            Ok(head) if !looks_like_websocket(head) => {
                let response = status_response();
                let socket = stream.get_mut();
                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.flush().await;
                return;
            }
            Ok(_) => {}
            Err(_) => return,
        }

        // The token no longer rides in the URL: it is carried inside the
        // client's encrypted auth frame, so it never lands in access logs.
        #[allow(clippy::result_large_err, reason = "signature fixed by tokio-tungstenite")]
        let Ok(mut socket) = accept_hdr_async(
            stream,
            move |request: &tokio_tungstenite::tungstenite::handshake::server::Request,
                  response| {
                if websocket_path(request.uri()) {
                    Ok(response)
                } else {
                    Err(rejected())
                }
            },
        )
        .await
        else {
            return;
        };

        // The auth frame is the first thing on the socket. Decrypting it proves
        // the client holds the application key; the token inside authorizes it,
        // and the client-chosen session id binds every later frame to this
        // connection.
        let auth = match tokio::time::timeout(AUTH_TIMEOUT, socket.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => text.to_string(),
            _ => return,
        };
        let (auth_plain, session_id, auth_seq) = match decrypt_relay_frame(&auth, &encryption_key) {
            Ok(frame) => frame,
            Err(_) => return,
        };
        let authorized = serde_json::from_str::<Value>(&auth_plain)
            .ok()
            .is_some_and(|value| {
                value.get("type").and_then(Value::as_str) == Some("auth")
                    && value.get("token").and_then(Value::as_str) == Some(&token)
                    && value.get("protocol").and_then(Value::as_str) == Some(PROTOCOL)
            });
        if !authorized {
            return;
        }
        let mut cipher = FrameCipher::new(encryption_key);
        if cipher.accept_auth(session_id, auth_seq).is_err() {
            return;
        }

        let hello = json!({"type":"host.hello","protocol":PROTOCOL,"hostId":host_id,"serverTime":unix_millis(),"theme":app.state::<RemoteHost>().theme(),"machineName":app.state::<RemoteHost>().info().map(|info| info.machine_name).unwrap_or_else(|| "Orbit Desktop".into())}).to_string();
        let hello = match cipher.encrypt_hello(&hello) {
            Ok(frame) => frame,
            Err(_) => return,
        };
        if socket.send(Message::text(hello)).await.is_err() {
            return;
        }

        let client_id = Uuid::new_v4();
        let (outbound, mut incoming) = tokio::sync::mpsc::channel::<String>(CLIENT_QUEUE_CAPACITY);
        let response_sender = outbound.clone();
        let session = Session {
            attached: Arc::new(Mutex::new(HashSet::new())),
            screen: ScreenSubscription::new(app.state::<ScreenHost>().bus()),
        };
        if let Ok(mut connected) = clients.map.lock() {
            connected.insert(
                client_id,
                Client {
                    sender: outbound,
                    projects: session.attached.clone(),
                    screen: session.screen.clone(),
                },
            );
        }

        // The receiver is owned here, and the bus signals it on every publish,
        // so a frame never waits for a timer to be noticed.
        let mut screen_wake = session.screen.take_wake();
        let mut shutdown = tokio::time::interval(SHUTDOWN_CHECK_INTERVAL);
        shutdown.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        loop {
            tokio::select! {
                // Control traffic first: a queued reply must not wait behind a
                // screen frame that is still going out.
                biased;
                Some(frame) = incoming.recv() => {
                    let frame = match cipher.encrypt(&frame) {
                        Ok(frame) => frame,
                        Err(_) => break,
                    };
                    if socket.send(Message::text(frame)).await.is_err() {
                        break;
                    }
                }
                Some(message) = socket.next() => {
                    match message {
                        Ok(Message::Text(text)) => {
                            let text = match cipher.decrypt(&text) {
                                Ok(plain) => plain,
                                Err(_) => break,
                            };
                            // 慢操作后台化：同 relay 路径的理由。该连接的屏幕帧
                            // 依赖这个循环发送，内联等待会让画面一起停摆。
                            if is_slow_request(&text) {
                                let app = app.clone();
                                let sender = response_sender.clone();
                                let detached = Session {
                                    attached: session.attached.clone(),
                                    screen: session.screen.clone(),
                                };
                                tauri::async_runtime::spawn(async move {
                                    if let Some(response) = handle_request(&app, &text, &detached).await {
                                        let _ = sender.send(response).await;
                                    }
                                });
                                continue;
                            }
                            let Some(response) = handle_request(&app, &text, &session).await else {
                                continue;
                            };
                            let response = match cipher.encrypt(&response) {
                                Ok(frame) => frame,
                                Err(_) => break,
                            };
                            if socket.send(Message::text(response)).await.is_err() {
                                break;
                            }
                        }
                        Ok(Message::Close(_)) => break,
                        Ok(_) => {}
                        Err(_) => break,
                    }
                }
                Some(()) = wake(&mut screen_wake) => {
                    if !send_screen_frame(&mut socket, &session.screen, &mut cipher).await {
                        break;
                    }
                }
                _ = shutdown.tick() => {
                    if stop.load(Ordering::Acquire) {
                        break;
                    }
                }
            }
        }

        if let Ok(mut connected) = clients.map.lock() {
            connected.remove(&client_id);
        }
    }

    /// Await the screen wake signal, or never resolve when there is none.
    ///
    /// (`select!` needs a future for every branch, and a subscription whose
    /// receiver was already taken has nothing to wait on.)
    async fn wake(receiver: &mut Option<tokio::sync::mpsc::Receiver<()>>) -> Option<()> {
        match receiver {
            Some(receiver) => receiver.recv().await,
            // A subscription whose receiver was already taken has nothing to
            // wait on, so this branch simply never fires.
            None => std::future::pending().await,
        }
    }

    /// Open a WebSocket to the relay.
    ///
    /// The TLS stays OpenSSL on purpose: some domestic ISP middleboxes reset
    /// handshakes from less common client fingerprints, and OpenSSL's is
    /// reliably allowed. That is also why this goes through
    /// [`client_async`](tokio_tungstenite::client_async) with an OpenSSL stream
    /// rather than the crate's own TLS connectors — those are rustls or
    /// Security.framework, which would change the fingerprint this exists to
    /// keep.
    ///
    /// The upgrade request itself is now the library's, which is a correctness
    /// gain over the hand-written one it replaces.
    async fn relay_connect(
        relay_url: &str,
        host_id: &str,
    ) -> Result<WebSocketStream<tokio_openssl::SslStream<TcpStream>>, String> {
        use openssl::ssl::{SslConnector, SslMethod};
        let uri = tokio_tungstenite::tungstenite::http::Uri::try_from(relay_url)
            .map_err(|_| "Relay 地址无效".to_string())?;
        let host = uri
            .host()
            .ok_or_else(|| "Relay 地址缺少主机".to_string())?
            .to_owned();
        let port = uri.port_u16().unwrap_or(443);
        let path = format!(
            "{}/relay/host/{host_id}",
            uri.path().trim_end_matches('/')
        );
        let tcp = TcpStream::connect((host.as_str(), port))
            .await
            .map_err(|error| format!("连接 Relay 失败：{error}"))?;
        tcp.set_nodelay(true).ok();

        let mut builder =
            SslConnector::builder(SslMethod::tls()).map_err(|error| error.to_string())?;
        // Vendored OpenSSL ships no trust store; load the system roots.
        if let Some(cert_file) = openssl_probe::probe().cert_file {
            if let Ok(pem) = std::fs::read(cert_file) {
                for cert in openssl::x509::X509::stack_from_pem(&pem).into_iter().flatten() {
                    let _ = builder.cert_store_mut().add_cert(cert);
                }
            }
        }
        let ssl = builder
            .build()
            .configure()
            .map_err(|error| error.to_string())?
            .into_ssl(&host)
            .map_err(|error| error.to_string())?;
        let mut tls = tokio_openssl::SslStream::new(ssl, tcp).map_err(|error| error.to_string())?;
        Pin::new(&mut tls)
            .connect()
            .await
            .map_err(|error| format!("Relay TLS 握手失败：{error}"))?;

        // `wss://` so the library builds the request; the TLS is already up.
        let request = format!("wss://{host}:{port}{path}")
            .into_client_request()
            .map_err(|error| format!("Relay 升级请求无效：{error}"))?;
        let (socket, _response) = client_async(request, tls)
            .await
            .map_err(|error| format!("Relay 升级失败：{error}"))?;
        Ok(socket)
    }

    fn relay_envelope(client_id: &str, data: String) -> Message {
        Message::text(json!({"relay":"frame","clientId":client_id,"data":data}).to_string())
    }

    fn frame_aad(session_id: &[u8; SESSION_ID_LEN], seq: u64) -> Vec<u8> {
        let mut value = Vec::with_capacity(SESSION_ID_LEN + SEQ_LEN);
        value.extend_from_slice(session_id);
        value.extend_from_slice(&seq.to_be_bytes());
        value
    }

    fn encrypt_relay_frame(
        value: &str,
        key: &[u8; 32],
        session_id: &[u8; SESSION_ID_LEN],
        seq: u64,
    ) -> Result<String, String> {
        let cipher = Aes256Gcm::new_from_slice(key).map_err(|error| error.to_string())?;
        let mut nonce = [0_u8; NONCE_LEN];
        OsRng.fill_bytes(&mut nonce);
        let aad = frame_aad(session_id, seq);
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: value.as_bytes(),
                    aad: aad.as_slice(),
                },
            )
            .map_err(|_| "Relay 加密失败".to_string())?;
        let mut frame =
            Vec::with_capacity(SESSION_ID_LEN + SEQ_LEN + NONCE_LEN + ciphertext.len());
        frame.extend_from_slice(session_id);
        frame.extend_from_slice(&seq.to_be_bytes());
        frame.extend_from_slice(&nonce);
        frame.extend_from_slice(&ciphertext);
        Ok(URL_SAFE_NO_PAD.encode(frame))
    }

    fn decrypt_relay_frame(
        value: &str,
        key: &[u8; 32],
    ) -> Result<(String, [u8; SESSION_ID_LEN], u64), String> {
        let frame = URL_SAFE_NO_PAD
            .decode(value)
            .map_err(|_| "Relay 加密帧无效".to_string())?;
        if frame.len() < SESSION_ID_LEN + SEQ_LEN + NONCE_LEN + 16 {
            return Err("Relay 加密帧无效".into());
        }
        let session_id: [u8; SESSION_ID_LEN] = frame[..SESSION_ID_LEN]
            .try_into()
            .map_err(|_| "Relay 加密帧无效".to_string())?;
        let seq = u64::from_be_bytes(
            frame[SESSION_ID_LEN..SESSION_ID_LEN + SEQ_LEN]
                .try_into()
                .map_err(|_| "Relay 加密帧无效".to_string())?,
        );
        let cipher = Aes256Gcm::new_from_slice(key).map_err(|error| error.to_string())?;
        let aad = frame_aad(&session_id, seq);
        let plaintext = cipher
            .decrypt(
                Nonce::from_slice(
                    &frame[SESSION_ID_LEN + SEQ_LEN..SESSION_ID_LEN + SEQ_LEN + NONCE_LEN],
                ),
                Payload {
                    msg: &frame[SESSION_ID_LEN + SEQ_LEN + NONCE_LEN..],
                    aad: aad.as_slice(),
                },
            )
            .map_err(|_| "Relay 加密帧认证失败".to_string())?;
        Ok((
            String::from_utf8(plaintext).map_err(|_| "Relay 明文不是有效 UTF-8".to_string())?,
            session_id,
            seq,
        ))
    }

    /// Per-connection crypto state: the client-chosen session id, the last
    /// sequence accepted, and the next sequence to send. The session id and
    /// sequence are authenticated as AES-GCM AAD, so a frame captured on one
    /// connection can neither be replayed on another nor replayed/out-of-order
    /// within the same one.
    struct FrameCipher {
        key: Arc<[u8; 32]>,
        session_id: Option<[u8; SESSION_ID_LEN]>,
        in_seq: u64,
        out_seq: u64,
    }

    impl FrameCipher {
        fn new(key: Arc<[u8; 32]>) -> Self {
            Self {
                key,
                session_id: None,
                in_seq: 0,
                out_seq: 0,
            }
        }

        fn authenticated(&self) -> bool {
            self.session_id.is_some()
        }

        /// Establish the session from the client's encrypted auth frame. The
        /// auth frame itself is seq 0 and is never replayed through `decrypt`.
        fn accept_auth(
            &mut self,
            session_id: [u8; SESSION_ID_LEN],
            seq: u64,
        ) -> Result<(), String> {
            if seq != 0 {
                return Err("认证帧序列号必须为 0".into());
            }
            if self.session_id.is_some() {
                return Err("连接已经认证".into());
            }
            self.session_id = Some(session_id);
            self.in_seq = 0;
            self.out_seq = 0;
            Ok(())
        }

        fn encrypt_hello(&self, plain: &str) -> Result<String, String> {
            let session_id = self
                .session_id
                .ok_or_else(|| "连接尚未认证".to_string())?;
            encrypt_relay_frame(plain, self.key.as_ref(), &session_id, 0)
        }

        fn decrypt(&mut self, value: &str) -> Result<String, String> {
            let (plain, session_id, seq) = decrypt_relay_frame(value, self.key.as_ref())?;
            let expected = self
                .session_id
                .ok_or_else(|| "连接尚未认证".to_string())?;
            if session_id != expected {
                return Err("会话标识不匹配".into());
            }
            if seq <= self.in_seq {
                return Err("消息重放或乱序".into());
            }
            self.in_seq = seq;
            Ok(plain)
        }

        fn encrypt(&mut self, plain: &str) -> Result<String, String> {
            let session_id = self
                .session_id
                .ok_or_else(|| "连接尚未认证".to_string())?;
            let seq = self.out_seq + 1;
            let frame = encrypt_relay_frame(plain, self.key.as_ref(), &session_id, seq)?;
            self.out_seq = seq;
            Ok(frame)
        }
    }

    fn ensure_relay_client(
        app: &AppHandle,
        client_id: &str,
        clients: &Clients,
        relay_clients: &mut HashMap<String, RelayClient>,
        encryption_key: Arc<[u8; 32]>,
    ) {
        if let Some(previous) = relay_clients.remove(client_id) {
            if let Ok(mut connected) = clients.map.lock() {
                connected.remove(&previous.local_id);
            }
        }
        let (outbound, incoming) = tokio::sync::mpsc::channel::<String>(CLIENT_QUEUE_CAPACITY);
        let attached = Arc::new(Mutex::new(HashSet::new()));
        let local_id = Uuid::new_v4();
        let screen = ScreenSubscription::new(app.state::<ScreenHost>().bus());
        if let Ok(mut connected) = clients.map.lock() {
            connected.insert(
                local_id,
                Client {
                    sender: outbound,
                    projects: attached.clone(),
                    screen: screen.clone(),
                },
            );
        }
        relay_clients.insert(
            client_id.to_owned(),
            RelayClient {
                local_id,
                attached,
                incoming,
                screen,
                cipher: FrameCipher::new(encryption_key),
            },
        );
    }

    fn clear_relay_clients(clients: &Clients, relay_clients: &mut HashMap<String, RelayClient>) {
        if let Ok(mut connected) = clients.map.lock() {
            for relay_client in relay_clients.values() {
                connected.remove(&relay_client.local_id);
            }
        }
        relay_clients.clear();
    }

    /// Keep the host registered with the relay and serve its clients.
    ///
    /// Async for the same reason as the LAN loop: reading and writing the same
    /// socket at once means neither has to wait for a timer to notice the other.
    #[allow(clippy::too_many_arguments, reason = "one loop, one set of host state")]
    async fn relay_loop(
        app: AppHandle,
        relay_url: String,
        host_id: String,
        host_key: String,
        client_token: String,
        encryption_key: Arc<[u8; 32]>,
        clients: Arc<Clients>,
        relay_connected: Arc<AtomicBool>,
        stop: Arc<AtomicBool>,
    ) {
        while !stop.load(Ordering::Acquire) {
            let mut socket = match relay_connect(&relay_url, &host_id).await {
                Ok(socket) => socket,
                Err(error) => {
                    log::warn!("Relay 连接失败：{error}");
                    sleep_or_stop(&stop, Duration::from_secs(2)).await;
                    continue;
                }
            };
            // Prove the desktop identity with the host key before the relay
            // accepts any client traffic for this host id.
            let register = json!({
                "relay": "register",
                "hostKey": host_key,
                "clientToken": client_token,
            })
            .to_string();
            if socket.send(Message::text(register)).await.is_err() {
                let _ = socket.close(None).await;
                sleep_or_stop(&stop, Duration::from_secs(2)).await;
                continue;
            }
            // Registration is acknowledged, not assumed: the relay answers
            // {"relay":"registered"} only after it accepted the host key, and
            // closes the socket otherwise. Waiting for that ack is what makes
            // `relay_connected` mean "phones can actually reach this machine"
            // instead of "we sent a message", so a phone scanning the QR code is
            // not pointed at a relay that will 404 for a few seconds.
            let mut registered = false;
            let register_deadline = Instant::now() + Duration::from_secs(10);
            loop {
                if stop.load(Ordering::Acquire) {
                    break;
                }
                let remaining = register_deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    log::warn!("Relay 注册确认超时，准备重连");
                    break;
                }
                match tokio::time::timeout(remaining, socket.next()).await {
                    Ok(Some(Ok(Message::Text(text)))) => {
                        let accepted = serde_json::from_str::<Value>(&text)
                            .ok()
                            .and_then(|value| {
                                value
                                    .get("relay")
                                    .and_then(Value::as_str)
                                    .map(|kind| kind == "registered")
                            })
                            .unwrap_or(false);
                        if accepted {
                            registered = true;
                            break;
                        }
                    }
                    Ok(Some(Ok(Message::Ping(payload)))) => {
                        let _ = socket.send(Message::Pong(payload)).await;
                    }
                    Ok(Some(Ok(Message::Close(frame)))) => {
                        log::warn!("Relay 拒绝 Host 注册：{frame:?}");
                        break;
                    }
                    Ok(Some(Ok(_))) => {}
                    Ok(Some(Err(error))) => {
                        log::warn!("Relay 注册阶段连接断开：{error}");
                        break;
                    }
                    Ok(None) => {
                        log::warn!("Relay 在注册确认前关闭了连接");
                        break;
                    }
                    Err(_) => {
                        log::warn!("Relay 注册确认超时，准备重连");
                        break;
                    }
                }
            }
            if !registered {
                let _ = socket.close(None).await;
                if !stop.load(Ordering::Acquire) {
                    sleep_or_stop(&stop, Duration::from_secs(2)).await;
                }
                continue;
            }
            relay_connected.store(true, Ordering::Release);
            let mut relay_clients = HashMap::<String, RelayClient>::new();
            let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
            heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

            'connection: loop {
                if stop.load(Ordering::Acquire) {
                    break;
                }
                // Outbound work: what each client has queued, plus the newest
                // frame for each subscribed client. Built before the select so a
                // client that appeared mid-iteration is not skipped.
                let mut outbound: Vec<(String, String)> = Vec::new();
                for (client_id, client) in relay_clients.iter_mut() {
                    if !client.cipher.authenticated() {
                        continue;
                    }
                    while let Ok(data) = client.incoming.try_recv() {
                        match client.cipher.encrypt(&data) {
                            Ok(frame) => outbound.push((client_id.clone(), frame)),
                            Err(_) => continue,
                        }
                    }
                    if let Some(frame) = client.screen.poll() {
                        match client.cipher.encrypt(&frame.envelope) {
                            Ok(frame) => outbound.push((client_id.clone(), frame)),
                            Err(_) => continue,
                        }
                    }
                }
                for (client_id, frame) in outbound {
                    if socket.send(relay_envelope(&client_id, frame)).await.is_err() {
                        break 'connection;
                    }
                }

                tokio::select! {
                    // Outbound work queued by any thread, for any client. Without
                    // this branch the drain above would only run when the relay
                    // socket happened to wake the loop.
                    () = clients.work.notified() => {}
                    _ = heartbeat.tick() => {
                        if socket.send(Message::Ping(Vec::new().into())).await.is_err() {
                            log::warn!("Relay 心跳发送失败，准备重连");
                            break 'connection;
                        }
                    }
                    // Waiting on the socket is what makes the loop event driven;
                    // the outbound drain above runs once per wakeup, and a queued
                    // message wakes it because the sender is the one doing the
                    // sending. When nothing is queued and nothing arrives, this
                    // parks with no timer at all.
                    message = socket.next() => {
                        match message {
                            Some(Ok(Message::Text(text))) => {
                                let Ok(frame) = serde_json::from_str::<Value>(&text) else {
                                    continue;
                                };
                                let Some(client_id) = frame.get("clientId").and_then(Value::as_str) else {
                                    continue;
                                };
                                match frame.get("relay").and_then(Value::as_str) {
                                    Some("connect") => {
                                        ensure_relay_client(
                                            &app,
                                            client_id,
                                            &clients,
                                            &mut relay_clients,
                                            encryption_key.clone(),
                                        );
                                    }
                                    Some("disconnect") => {
                                        if let Some(client) = relay_clients.remove(client_id) {
                                            clients
                                                .map
                                                .lock()
                                                .ok()
                                                .map(|mut connected| connected.remove(&client.local_id));
                                        }
                                    }
                                    Some("frame") => {
                                        if !relay_clients.contains_key(client_id) {
                                            ensure_relay_client(
                                                &app,
                                                client_id,
                                                &clients,
                                                &mut relay_clients,
                                                encryption_key.clone(),
                                            );
                                        }
                                        let Some(data) = frame.get("data").and_then(Value::as_str) else {
                                            continue;
                                        };
                                        let Some(client) = relay_clients.get_mut(client_id) else {
                                            continue;
                                        };
                                        // The first frame from a new relay client is its
                                        // encrypted auth frame, which establishes the
                                        // per-connection session and authorizes it.
                                        if !client.cipher.authenticated() {
                                            let (auth_plain, session_id, auth_seq) =
                                                match decrypt_relay_frame(data, &encryption_key) {
                                                    Ok(frame) => frame,
                                                    Err(_) => continue,
                                                };
                                            let authorized = serde_json::from_str::<Value>(&auth_plain)
                                                .ok()
                                                .is_some_and(|value| {
                                                    value.get("type").and_then(Value::as_str)
                                                        == Some("auth")
                                                        && value.get("token").and_then(Value::as_str)
                                                            == Some(&client_token)
                                                        && value.get("protocol").and_then(Value::as_str)
                                                            == Some(PROTOCOL)
                                                });
                                            if !authorized {
                                                continue;
                                            }
                                            if client.cipher.accept_auth(session_id, auth_seq).is_err() {
                                                continue;
                                            }
                                            let hello = json!({
                                                "type":"host.hello",
                                                "protocol":PROTOCOL,
                                                "hostId":host_id,
                                                "serverTime":unix_millis(),
                                                "theme":app.state::<RemoteHost>().theme(),
                                                "machineName":app.state::<RemoteHost>().info().map(|info| info.machine_name).unwrap_or_else(|| "Orbit Desktop".into())
                                            }).to_string();
                                            let hello = match client.cipher.encrypt_hello(&hello) {
                                                Ok(hello) => hello,
                                                Err(_) => break 'connection,
                                            };
                                            if socket.send(relay_envelope(client_id, hello)).await.is_err() {
                                                break 'connection;
                                            }
                                            continue;
                                        }
                                        let plain = match client.cipher.decrypt(data) {
                                            Ok(plain) => plain,
                                            Err(_) => continue,
                                        };
                                        let session = Session {
                                            attached: client.attached.clone(),
                                            screen: client.screen.clone(),
                                        };
                                        // session.list 一类的慢操作要把全部会话 JSONL
                                        // 过一遍，可能耗时数十秒。内联 await 会把整个
                                        // relay 任务卡住——屏幕帧、心跳、其他客户端全部
                                        // 停摆。慢操作放后台跑，完成后把明文响应塞回该
                                        // 客户端的出站队列，由统一的 drain 加密发送。
                                        if is_slow_request(&plain) {
                                            let sender = clients.map.lock().ok().and_then(|connected| {
                                                connected.get(&client.local_id).map(|entry| entry.sender.clone())
                                            });
                                            if let Some(sender) = sender {
                                                let app = app.clone();
                                                let work = clients.work.clone();
                                                tauri::async_runtime::spawn(async move {
                                                    let Some(response) = handle_request(&app, &plain, &session).await else {
                                                        return;
                                                    };
                                                    if sender.send(response).await.is_ok() {
                                                        work.notify_one();
                                                    }
                                                });
                                                continue;
                                            }
                                        }
                                        let Some(response) = handle_request(&app, &plain, &session).await else {
                                            continue;
                                        };
                                        let encrypted = match client.cipher.encrypt(&response) {
                                            Ok(encrypted) => encrypted,
                                            Err(_) => break 'connection,
                                        };
                                        if socket.send(relay_envelope(client_id, encrypted)).await.is_err() {
                                            break 'connection;
                                        }
                                    }
                                    _ => {}
                                }
                            }
                            Some(Ok(Message::Ping(payload))) => {
                                if socket.send(Message::Pong(payload)).await.is_err() {
                                    break 'connection;
                                }
                            }
                            Some(Ok(Message::Close(frame))) => {
                                log::warn!("Relay 主动关闭 Host 连接：{frame:?}");
                                break 'connection;
                            }
                            Some(Ok(_)) => {}
                            Some(Err(error)) => {
                                log::warn!("Relay Host 连接断开：{error}");
                                break 'connection;
                            }
                            None => break 'connection,
                        }
                    }
                    _ = tokio::time::sleep(SHUTDOWN_CHECK_INTERVAL) => {
                        if stop.load(Ordering::Acquire) {
                            break 'connection;
                        }
                    }
                }
            }
            clear_relay_clients(&clients, &mut relay_clients);
            relay_connected.store(false, Ordering::Release);
            if !stop.load(Ordering::Acquire) {
                sleep_or_stop(&stop, Duration::from_secs(1)).await;
            }
        }
    }

    /// Sleep, but wake early when the host is asked to stop.
    async fn sleep_or_stop(stop: &AtomicBool, duration: Duration) {
        let deadline = Instant::now() + duration;
        while !stop.load(Ordering::Acquire) && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(100).min(duration)).await;
        }
    }

    pub(super) fn start(
        app: AppHandle,
        bind_address: Option<String>,
        mode: Option<String>,
        port: Option<u16>,
        state: State<'_, RemoteHost>,
    ) -> Result<RemoteHostInfo, String> {
        if let Some(info) = state.info() {
            return Ok(info);
        }
        match mode.as_deref().unwrap_or("lan") {
            "lan" => start_lan(app, bind_address, port, state),
            "relay" => start_relay(app, state),
            "auto" => start_auto(app, bind_address, port, state),
            _ => Err("不支持的连接方式".into()),
        }
    }

    fn start_lan(
        app: AppHandle,
        bind_address: Option<String>,
        port: Option<u16>,
        state: State<'_, RemoteHost>,
    ) -> Result<RemoteHostInfo, String> {
        let bind = bind_address.clone().unwrap_or_else(|| "0.0.0.0".into());
        let address = bind
            .parse::<IpAddr>()
            .map_err(|_| "Host 绑定地址无效".to_string())?;
        let mut identity = load_host_identity()?;
        let preferred_port = port.or(identity.lan_port).unwrap_or(0);
        let listener = match TcpListener::bind(SocketAddr::new(address, preferred_port)) {
            Ok(listener) => listener,
            Err(error) if port.is_none() && identity.lan_port.is_some() => TcpListener::bind(
                SocketAddr::new(address, 0),
            )
            .map_err(|fallback| format!("启动 Orbit Host 失败：{error}；备用端口也不可用：{fallback}"))?,
            Err(error) => return Err(format!("启动 Orbit Host 失败：{error}")),
        };
        listener
            .set_nonblocking(true)
            .map_err(|error| error.to_string())?;
        let local = listener.local_addr().map_err(|error| error.to_string())?;
        let advertised = if address.is_unspecified() {
            let lan = advertised_address(IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED));
            if lan == "127.0.0.1" {
                return Err("未检测到可供手机连接的局域网地址".into());
            }
            lan
        } else {
            address.to_string()
        };
        identity.lan_port = Some(local.port());
        save_host_identity(&identity)?;
        let token = identity.token.clone();
        let host_id = identity.host_id.clone();
        let mut key_bytes = [0_u8; 32];
        key_bytes.copy_from_slice(&URL_SAFE_NO_PAD.decode(&identity.relay_key).map_err(|_| "Orbit LAN 加密密钥无效".to_string())?);
        let encryption_key = Arc::new(key_bytes);
        let info = RemoteHostInfo {
            running: true,
            mode: "lan".into(),
            protocol: PROTOCOL,
            host_id: host_id.clone(),
            bind_address: bind,
            advertised_address: advertised.clone(),
            port: local.port(),
            token: token.clone(),
            pairing_uri: pairing_uri(&advertised, local.port(), &token, &identity.relay_key, &host_id),
            machine_name: machine_name(),
            connected_clients: 0,
            relay_url: None,
            relay_connected: false,
        };
        let stop = Arc::new(AtomicBool::new(false));
        let clients = Arc::new(Clients::new());
        let (events, event_receiver) = mpsc::sync_channel(EVENT_QUEUE_CAPACITY);
        let broadcast_clients = clients.clone();
        let broadcast_stop = stop.clone();
        thread::spawn(move || broadcast_loop(event_receiver, broadcast_clients, broadcast_stop));
        let accept_clients = clients.clone();
        let accept_stop = stop.clone();
        let accept_app = app.clone();
        let accept_token = token;
        let accept_host_id = host_id;
        let accept_key = encryption_key.clone();
        let mut slot = state.running.lock().map_err(|error| error.to_string())?;
        *slot = Some(RunningHost {
            info: info.clone(),
            stop,
            relay_connected: Arc::new(AtomicBool::new(false)),
            clients,
            events,
        });
        drop(slot);
        tauri::async_runtime::spawn(async move {
            let listener = match tokio::net::TcpListener::from_std(listener) {
                Ok(listener) => listener,
                Err(error) => {
                    log::warn!("Orbit Host 监听器无法交给异步运行时：{error}");
                    return;
                }
            };
            loop {
                if accept_stop.load(Ordering::Acquire) {
                    return;
                }
                // `select!` with the shutdown flag rather than a polling accept:
                // this loop has no work to poll for, it waits.
                let accepted = tokio::select! {
                    accepted = listener.accept() => accepted,
                    _ = tokio::time::sleep(SHUTDOWN_CHECK_INTERVAL) => continue,
                };
                let Ok((stream, _)) = accepted else {
                    continue;
                };
                let app = accept_app.clone();
                let token = accept_token.clone();
                let clients = accept_clients.clone();
                let stop = accept_stop.clone();
                let host_id = accept_host_id.clone();
                let encryption_key = accept_key.clone();
                tauri::async_runtime::spawn(async move {
                    client_loop(app, stream, token, clients, stop, host_id, encryption_key).await
                });
            }
        });
        Ok(info)
    }

    fn start_auto(
        app: AppHandle,
        bind_address: Option<String>,
        port: Option<u16>,
        state: State<'_, RemoteHost>,
    ) -> Result<RemoteHostInfo, String> {
        let lan_info = start_lan(app.clone(), bind_address, port, state.clone())?;
        let settings = match load_relay_settings() {
            Ok(settings) => settings,
            Err(_) => return Ok(lan_info),
        };
        let identity = load_host_identity()?;
        let mut key_bytes = [0_u8; 32];
        key_bytes.copy_from_slice(
            &URL_SAFE_NO_PAD
                .decode(&identity.relay_key)
                .map_err(|_| "Orbit Relay 加密密钥无效".to_string())?,
        );
        let (host_id, token, clients, relay_connected, stop, pairing_uri) = {
            let mut slot = state.running.lock().map_err(|error| error.to_string())?;
            let host = slot.as_mut().ok_or_else(|| "Orbit Host 启动失败".to_string())?;
            let pairing_uri = auto_pairing_uri(
                &host.info.advertised_address,
                host.info.port,
                &settings.relay_url,
                &host.info.host_id,
                &host.info.token,
                &identity.relay_key,
            );
            host.info.mode = "auto".into();
            host.info.relay_url = Some(settings.relay_url.clone());
            host.info.pairing_uri = pairing_uri.clone();
            (
                host.info.host_id.clone(),
                host.info.token.clone(),
                host.clients.clone(),
                host.relay_connected.clone(),
                host.stop.clone(),
                pairing_uri,
            )
        };
        let relay_url = settings.relay_url;
        let host_key = settings.host_key;
        tauri::async_runtime::spawn(relay_loop(
            app,
            relay_url,
            host_id,
            host_key,
            token,
            Arc::new(key_bytes),
            clients,
            relay_connected,
            stop,
        ));
        let mut info = state.info().ok_or_else(|| "Orbit Host 启动失败".to_string())?;
        info.pairing_uri = pairing_uri;
        Ok(info)
    }

    fn start_relay(app: AppHandle, state: State<'_, RemoteHost>) -> Result<RemoteHostInfo, String> {
        let settings = load_relay_settings()?;
        let identity = load_host_identity()?;
        let token = identity.token.clone();
        let host_id = identity.host_id.clone();
        let encryption_key_value = identity.relay_key.clone();
        let mut key_bytes = [0_u8; 32];
        key_bytes.copy_from_slice(
            &URL_SAFE_NO_PAD
                .decode(&encryption_key_value)
                .map_err(|_| "Relay 加密密钥无效".to_string())?,
        );
        let info = RemoteHostInfo {
            running: true,
            mode: "relay".into(),
            protocol: PROTOCOL,
            host_id: host_id.clone(),
            bind_address: "127.0.0.1".into(),
            advertised_address: relay_host(&settings.relay_url),
            port: 0,
            token: token.clone(),
            pairing_uri: relay_pairing_uri(
                &settings.relay_url,
                &host_id,
                &token,
                &encryption_key_value,
            ),
            machine_name: machine_name(),
            connected_clients: 0,
            relay_url: Some(settings.relay_url.clone()),
            relay_connected: false,
        };
        let stop = Arc::new(AtomicBool::new(false));
        let clients = Arc::new(Clients::new());
        let (events, event_receiver) = mpsc::sync_channel(EVENT_QUEUE_CAPACITY);
        let broadcast_clients = clients.clone();
        let broadcast_stop = stop.clone();
        thread::spawn(move || broadcast_loop(event_receiver, broadcast_clients, broadcast_stop));
        let relay_connected = Arc::new(AtomicBool::new(false));
        let relay_args = (
            app,
            settings.relay_url,
            host_id,
            settings.host_key,
            token,
            Arc::new(key_bytes),
            clients.clone(),
            relay_connected.clone(),
            stop.clone(),
        );
        let mut slot = state.running.lock().map_err(|error| error.to_string())?;
        *slot = Some(RunningHost {
            info: info.clone(),
            stop,
            relay_connected,
            clients,
            events,
        });
        drop(slot);
        {
            let (
                app,
                relay_url,
                host_id,
                host_key,
                client_token,
                encryption_key,
                clients,
                relay_connected,
                stop,
            ) = relay_args;
            tauri::async_runtime::spawn(relay_loop(
                app,
                relay_url,
                host_id,
                host_key,
                client_token,
                encryption_key,
                clients,
                relay_connected,
                stop,
            ));
        }
        Ok(info)
    }

    pub(super) fn relay_status() -> RelaySettingsStatus {
        load_relay_settings().map_or_else(
            |_| RelaySettingsStatus {
                relay_url: String::new(),
                has_host_key: false,
            },
            |settings| RelaySettingsStatus {
                relay_url: settings.relay_url,
                has_host_key: true,
            },
        )
    }

    pub(super) fn save_relay(settings: RelaySettings) -> Result<RelaySettingsStatus, String> {
        write_relay_settings(&settings)?;
        Ok(RelaySettingsStatus {
            relay_url: settings.relay_url,
            has_host_key: true,
        })
    }

    pub(super) fn status(state: State<'_, RemoteHost>) -> Option<RemoteHostInfo> {
        state.info()
    }

    pub(super) fn stop(state: State<'_, RemoteHost>) {
        state.stop();
    }

    pub(super) fn set_theme(theme: RemoteTheme, state: State<'_, RemoteHost>) {
        state.set_theme(theme);
    }

    pub(super) fn publish(app: &AppHandle, project: &str, payload: &Value) {
        app.state::<RemoteHost>().publish(project, payload);
    }

    pub(super) fn publish_connection_closed(app: &AppHandle, project: &str) {
        app.state::<RemoteHost>().publish_connection_closed(project);
    }

    pub(super) fn publish_all(app: &AppHandle, frame: &Value) {
        app.state::<RemoteHost>().publish_all(frame.clone());
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::str::FromStr;

        #[test]
        fn small_events_travel_as_one_batch() {
            let frames = event_frames(
                "/w/demo",
                vec![json!({"type":"message_update"}), json!({"type":"message_end"})],
            );
            assert_eq!(frames.len(), 1);
            let value: Value = serde_json::from_str(&frames[0]).unwrap();
            assert_eq!(value["type"], "pi.events");
            assert_eq!(value["project"], "/w/demo");
            assert_eq!(value["payloads"].as_array().unwrap().len(), 2);
        }

        /// 几百条消息的会话，`get_messages` 的响应就是一帧装不下的那种事件。
        /// 它必须被切成多帧，而不是丢掉——丢掉就是手机干等到超时。
        #[test]
        fn an_event_too_big_for_one_frame_is_chunked_not_dropped() {
            let payload = json!({
                "type": "response",
                "command": "get_messages",
                "id": "r1",
                "success": true,
                "data": { "messages": "x".repeat(MAX_EVENT_PAYLOAD_BYTES + 4096) },
            });
            let frames = event_frames("/w/demo", vec![payload.clone()]);
            assert!(frames.len() > 1, "巨型事件应该被切成多帧");

            let mut parts = vec![String::new(); frames.len()];
            for frame in &frames {
                assert!(
                    frame.len() <= EVENT_CHUNK_BYTES + 1024,
                    "任何一帧都不该大到卡住 relay"
                );
                let value: Value = serde_json::from_str(frame).unwrap();
                assert_eq!(value["type"], "pi.event.chunk");
                assert_eq!(value["project"], "/w/demo");
                assert_eq!(value["total"], frames.len());
                parts[value["index"].as_u64().unwrap() as usize] =
                    value["data"].as_str().unwrap().to_owned();
            }
            // 手机把片段按顺序拼起来，拿到的就是原来那条 payload。
            let reassembled: Value = serde_json::from_str(&parts.concat()).unwrap();
            assert_eq!(reassembled, payload);
        }

        /// 切片在字符边界上断开：多字节字符不能被切成两半。
        #[test]
        fn chunks_never_split_a_character() {
            let payload = json!({
                "type": "response",
                "id": "r3",
                "data": "汉".repeat(MAX_EVENT_PAYLOAD_BYTES / 3 + 1024),
            });
            let frames = event_frames("/w/demo", vec![payload.clone()]);
            assert!(frames.len() > 1);
            let mut parts = Vec::new();
            for frame in &frames {
                let value: Value = serde_json::from_str(frame).unwrap();
                parts.push(value["data"].as_str().unwrap().to_owned());
            }
            let reassembled: Value = serde_json::from_str(&parts.concat()).unwrap();
            assert_eq!(reassembled, payload);
        }

        /// 连切片都发不出去的响应，换一条明确的失败：手机要看到“太大”，
        /// 而不是一直等一个永远不来的响应。
        #[test]
        fn an_unshippable_response_still_answers() {
            let payload = json!({"type":"response","command":"get_messages","id":"r2","success":true,"data":{}});
            let response = oversized_response(&payload, MAX_CHUNKED_PAYLOAD_BYTES + 1).unwrap();
            assert_eq!(response["type"], "response");
            assert_eq!(response["id"], "r2");
            assert_eq!(response["success"], false);
            assert_eq!(response["command"], "get_messages");
            assert!(response["error"].as_str().unwrap().contains("响应过大"));
            // 别的类型没有等在那一头的请求，只能丢。
            assert!(oversized_response(&json!({"type":"message_update"}), 1).is_none());
        }

        #[test]
        fn accepts_only_the_websocket_path() {
            let valid = tungstenite::http::Uri::from_str("/ws").unwrap();
            let invalid = tungstenite::http::Uri::from_str("/other").unwrap();
            assert!(websocket_path(&valid));
            assert!(!websocket_path(&invalid));
        }

        #[test]
        fn pairing_uri_contains_the_negotiated_endpoint() {
            assert_eq!(
                pairing_uri("192.168.1.5", 17777, "abc", "key", "host-id"),
                "orbit://pair?host=192.168.1.5&port=17777&token=abc&key=key&hostId=host-id&protocol=orbit.remote.v1"
            );
        }

        #[test]
        fn relay_frames_round_trip_through_encryption() {
            let key_value = random_secret(32);
            let mut key = [0_u8; 32];
            key.copy_from_slice(&URL_SAFE_NO_PAD.decode(&key_value).unwrap());
            let session_id = [7_u8; SESSION_ID_LEN];
            let plain = json!({"type":"pi.command","project":"p"}).to_string();
            let encrypted = encrypt_relay_frame(&plain, &key, &session_id, 1).unwrap();
            assert_ne!(encrypted, plain);
            let (round, got_session, seq) = decrypt_relay_frame(&encrypted, &key).unwrap();
            assert_eq!(round, plain);
            assert_eq!(got_session, session_id);
            assert_eq!(seq, 1);
            assert!(decrypt_relay_frame(&encrypted, &[9_u8; 32]).is_err());
        }

        #[test]
        fn frame_cipher_rejects_replays_and_out_of_order() {
            let key = Arc::new([3_u8; 32]);
            let mut cipher = FrameCipher::new(key.clone());
            let session_id = [1_u8; SESSION_ID_LEN];
            cipher.accept_auth(session_id, 0).unwrap();
            assert!(cipher.authenticated());
            let first = encrypt_relay_frame("one", key.as_ref(), &session_id, 1).unwrap();
            let second = encrypt_relay_frame("two", key.as_ref(), &session_id, 2).unwrap();
            assert_eq!(cipher.decrypt(&second).unwrap(), "two");
            // Replaying `second` (seq 2) after seq already advanced is rejected.
            assert!(cipher.decrypt(&second).is_err());
            // `first` is now out of order and is rejected too.
            assert!(cipher.decrypt(&first).is_err());
        }

        #[test]
        fn relay_pairing_uri_carries_client_credentials_only() {
            let uri = relay_pairing_uri(
                "wss://relay.example.com",
                "host-12345678",
                "token1234567890",
                "keykeykeykeykeykeykeykeykeykeykeykeykey",
            );
            assert!(uri.contains("relay=wss%3A%2F%2Frelay.example.com"));
            assert!(uri.contains("key=keykeykeykeykeykeykeykeykeykeykeykeykey"));
            assert!(!uri.contains("hostKey"));
        }

        #[test]
        fn relay_settings_validate_transport_and_secrets() {
            let valid = RelaySettings {
                relay_url: "wss://relay.example.com".into(),
                host_key: "a".repeat(43),
            };
            assert!(validate_relay_settings(&valid).is_ok());
            let plain_http = RelaySettings {
                relay_url: "http://relay.example.com".into(),
                host_key: valid.host_key.clone(),
            };
            assert!(validate_relay_settings(&plain_http).is_err());
            let short_key = RelaySettings {
                relay_url: valid.relay_url.clone(),
                host_key: "short".into(),
            };
            assert!(validate_relay_settings(&short_key).is_err());
        }

        #[test]
        fn theme_is_retained_before_the_host_starts() {
            let host = RemoteHost::default();
            assert_eq!(host.theme(), RemoteTheme::Light);
            host.set_theme(RemoteTheme::Dark);
            assert_eq!(host.theme(), RemoteTheme::Dark);
            host.stop();
            assert_eq!(host.theme(), RemoteTheme::Dark);
        }

        #[test]
        fn theme_broadcast_reaches_clients_before_project_attachment() {
            let (sender, mut receiver) = tokio::sync::mpsc::channel(1);
            let clients = Arc::new(Clients::new());
            clients.map.lock().expect("map").insert(
                Uuid::new_v4(),
                Client {
                    sender,
                    projects: Arc::new(Mutex::new(HashSet::new())),
                    screen: ScreenSubscription::new(Arc::new(
                        crate::screen::ScreenBus::default(),
                    )),
                },
            );
            broadcast_all(
                &clients,
                json!({"type":"host.theme","theme":"dark"}).to_string(),
            );
            let frame = receiver.try_recv().expect("theme frame");
            assert_eq!(
                serde_json::from_str::<Value>(&frame).unwrap()["theme"],
                "dark"
            );
        }
    }
}

#[cfg(desktop)]
pub use desktop::RemoteHost;

#[cfg(mobile)]
#[derive(Default)]
pub struct RemoteHost;

#[cfg(mobile)]
impl RemoteHost {
    pub fn stop(&self) {}

    /// A mobile build is never the Host: the registry it would publish is
    /// always empty, and nothing on this device reads it.
    pub fn projects(&self) -> Vec<Value> {
        Vec::new()
    }

    pub fn set_projects(&self, _projects: Vec<Value>) {}
}

#[tauri::command]
pub fn remote_host_start(
    app: tauri::AppHandle,
    bind_address: Option<String>,
    mode: Option<String>,
    port: Option<u16>,
    state: tauri::State<'_, RemoteHost>,
) -> Result<RemoteHostInfo, String> {
    #[cfg(desktop)]
    {
        desktop::start(app, bind_address, mode, port, state)
    }
    #[cfg(mobile)]
    {
        let _ = (app, bind_address, mode, port, state);
        Err("移动端不能启动 Orbit Host，请连接一台桌面设备".into())
    }
}

#[tauri::command]
pub fn relay_settings_status() -> RelaySettingsStatus {
    #[cfg(desktop)]
    {
        desktop::relay_status()
    }
    #[cfg(mobile)]
    {
        RelaySettingsStatus {
            relay_url: String::new(),
            has_host_key: false,
        }
    }
}

#[tauri::command]
pub fn save_relay_settings(settings: RelaySettings) -> Result<RelaySettingsStatus, String> {
    #[cfg(desktop)]
    {
        desktop::save_relay(settings)
    }
    #[cfg(mobile)]
    {
        let _ = settings;
        Err("Relay 配置请在电脑端修改".into())
    }
}

/// The desktop window publishes its project registry for the phones.
///
/// Called whenever that list changes (and once at startup). The Host keeps the
/// latest publication so `host.snapshot` can answer with it, and forwards it to
/// every connected phone so a rail that is already open updates in place.
#[tauri::command]
pub fn publish_projects(state: tauri::State<'_, RemoteHost>, projects: Vec<Value>) {
    state.set_projects(projects);
}

#[tauri::command]
pub fn remote_host_status(state: tauri::State<'_, RemoteHost>) -> Option<RemoteHostInfo> {
    #[cfg(desktop)]
    {
        desktop::status(state)
    }
    #[cfg(mobile)]
    {
        let _ = state;
        None
    }
}

#[tauri::command]
pub fn remote_host_stop(state: tauri::State<'_, RemoteHost>) {
    #[cfg(desktop)]
    {
        desktop::stop(state)
    }
    #[cfg(mobile)]
    {
        let _ = state;
    }
}

#[tauri::command]
pub fn remote_host_set_theme(theme: RemoteTheme, state: tauri::State<'_, RemoteHost>) {
    #[cfg(desktop)]
    desktop::set_theme(theme, state);
    #[cfg(mobile)]
    let _ = (theme, state);
}

pub fn publish_pi_event(app: &tauri::AppHandle, project: &str, payload: &Value) {
    #[cfg(desktop)]
    desktop::publish(app, project, payload);
    #[cfg(mobile)]
    let _ = (app, project, payload);
}

pub fn publish_connection_closed(app: &tauri::AppHandle, project: &str) {
    #[cfg(desktop)]
    desktop::publish_connection_closed(app, project);
    #[cfg(mobile)]
    let _ = (app, project);
}

/// Forward one terminal frame to every attached client.
///
/// `pty_term` emits its output to the desktop window as a Tauri event, which a
/// paired phone never sees: the phone has its own window and its own event bus.
/// The same bytes are published here so the terminal dock works on a phone, and
/// `docs/MOBILE.md` records that it does.
///
/// No `pty` frame carries a path or a token: an `id` the phone itself chose,
/// and the child's own output.
pub fn publish_terminal(app: &tauri::AppHandle, frame: Value) {
    #[cfg(desktop)]
    desktop::publish_all(app, &frame);
    #[cfg(mobile)]
    let _ = (app, frame);
}
