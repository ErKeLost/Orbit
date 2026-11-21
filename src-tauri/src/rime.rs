//! Rime Prism: the call. This process holds the key and the socket.
//!
//! Prism hears the microphone, decides when a turn ends, stops when the person
//! talks over it, and speaks. Jev only decides whether those words go to the
//! working session. The key never reaches the webview.

use base64::Engine;
use serde_json::{json, Value};
use std::pin::Pin;

use crate::bridge;

const PROVIDER: &str = "rime";
const PRISM: &str = "prism.api.rime.ai";
const CODA: &str = "https://coda.api.rime.ai/";
const VOICE: &str = "aurora";
const SPEAK_VOICE: &str = "celeste";

const INSTRUCTIONS: &str = "\
You are the voice of a coding app. Reply in one or two short spoken sentences. \
Do not read code, logs, or lists. You do not edit files and you have no tools. \
A separate judge may pass the person's words to the working session. Never claim you changed the project. \
If they ask you to do work, say you are passing it to the working session. Do not start the work yourself.";

fn client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

fn auth_json() -> Result<Value, String> {
    let text = std::fs::read_to_string(bridge::agent_dir()?.join("auth.json")).unwrap_or_else(|_| "{}".into());
    serde_json::from_str(&text).map_err(|_| "Pi 的 auth.json 不是合法 JSON".to_string())
}

fn api_key() -> Result<String, String> {
    bridge::stored_api_key(&auth_json()?, PROVIDER)
        .ok_or_else(|| "还没有配置 Rime API Key（在语音设置里填一次即可）".to_string())
}

#[tauri::command]
pub async fn rime_config() -> Result<Value, String> {
    let has = auth_json().ok().and_then(|auth| bridge::stored_api_key(&auth, PROVIDER)).is_some();
    Ok(json!({ "hasCredential": has, "voice": VOICE, "language": "en" }))
}

#[tauri::command]
pub async fn save_rime_api_key(api_key: Option<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        bridge::store_provider_api_key(PROVIDER, api_key.as_deref())?;
        let has = auth_json().ok().and_then(|auth| bridge::stored_api_key(&auth, PROVIDER)).is_some();
        Ok(json!({ "hasCredential": has }))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// One sentence after the call has ended. Same key, Coda voice, not a second agent.
#[tauri::command]
pub async fn rime_speak(text: String) -> Result<Value, String> {
    let sentence = text.trim().to_string();
    if sentence.is_empty() || sentence.chars().count() > 400 {
        return Err("播报只能是一两句".into());
    }
    let key = api_key()?;
    let response = client()
        .post(CODA)
        .header("Authorization", format!("Bearer {key}"))
        .header("Accept", "audio/mpeg")
        .json(&json!({ "text": sentence, "speaker": SPEAK_VOICE }))
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|error| format!("合成失败：{error}"))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Rime {status}：{}", body.chars().take(180).collect::<String>()));
    }
    let bytes = response.bytes().await.map_err(|error| format!("合成没有返回声音：{error}"))?;
    Ok(json!({
        "audioBase64": base64::engine::general_purpose::STANDARD.encode(&bytes),
        "mime": "audio/mpeg",
    }))
}

type Socket = tokio_tungstenite::WebSocketStream<tokio_openssl::SslStream<tokio::net::TcpStream>>;

async fn connect_prism(key: &str) -> Result<Socket, String> {
    use openssl::ssl::{SslConnector, SslMethod};
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    let tcp = tokio::net::TcpStream::connect((PRISM, 443u16))
        .await
        .map_err(|error| format!("连接 Prism 失败：{error}"))?;
    tcp.set_nodelay(true).ok();
    let mut builder = SslConnector::builder(SslMethod::tls()).map_err(|error| error.to_string())?;
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
        .into_ssl(PRISM)
        .map_err(|error| error.to_string())?;
    let mut tls = tokio_openssl::SslStream::new(ssl, tcp).map_err(|error| error.to_string())?;
    Pin::new(&mut tls).connect().await.map_err(|error| format!("Prism TLS 失败：{error}"))?;

    let mut request = format!("wss://{PRISM}/v1/realtime")
        .into_client_request()
        .map_err(|error| format!("升级请求无效：{error}"))?;
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {key}").parse().map_err(|error| format!("请求头无效：{error}"))?,
    );
    let (socket, _) = tokio_tungstenite::client_async(request, tls)
        .await
        .map_err(|error| match error {
            tokio_tungstenite::tungstenite::Error::Http(response) => {
                format!("Prism 拒绝了连接（{}）", response.status())
            }
            other => format!("Prism 升级失败：{other}"),
        })?;
    Ok(socket)
}

enum Cmd {
    Audio(String),
    Truncate { item_id: String, audio_end_ms: u32 },
    Nudge(String),
    Close,
}

struct Live {
    tx: tokio::sync::mpsc::Sender<Cmd>,
}

static LIVE: std::sync::LazyLock<tokio::sync::Mutex<Option<Live>>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(None));

fn emit(channel: &tauri::ipc::Channel<Value>, body: Value) {
    let _ = channel.send(body);
}

fn text_of(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).unwrap_or("").trim().to_owned()
}

/// Open one Prism conversation. Audio starts only after this returns.
#[tauri::command]
pub async fn rime_prism_open(on_event: tauri::ipc::Channel<Value>) -> Result<Value, String> {
    let key = api_key()?;
    let (tx, rx) = tokio::sync::mpsc::channel(32);
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    {
        let mut live = LIVE.lock().await;
        if let Some(previous) = live.take() {
            let _ = previous.tx.try_send(Cmd::Close);
        }
        *live = Some(Live { tx });
    }
    tauri::async_runtime::spawn(run_prism(key, rx, on_event, ready_tx));
    match tokio::time::timeout(std::time::Duration::from_secs(15), ready_rx).await {
        Ok(Ok(Ok(()))) => Ok(json!({ "voice": VOICE, "language": "en" })),
        Ok(Ok(Err(error))) => {
            *LIVE.lock().await = None;
            Err(error)
        }
        _ => {
            *LIVE.lock().await = None;
            Err("Prism 没有接通".into())
        }
    }
}

#[tauri::command]
pub async fn rime_prism_audio(audio_base64: String) -> Result<(), String> {
    let live = LIVE.lock().await;
    let Some(live) = live.as_ref() else { return Err("语音还没接通".into()) };
    live.tx.send(Cmd::Audio(audio_base64)).await.map_err(|_| "语音连接已断开".to_string())
}

#[tauri::command]
pub async fn rime_prism_truncate(item_id: String, audio_end_ms: u32) -> Result<(), String> {
    let live = LIVE.lock().await;
    let Some(live) = live.as_ref() else { return Ok(()) };
    let _ = live.tx.try_send(Cmd::Truncate { item_id, audio_end_ms });
    Ok(())
}

#[tauri::command]
pub async fn rime_prism_nudge(text: String) -> Result<(), String> {
    let sentence = text.trim().to_string();
    if sentence.is_empty() { return Ok(()) }
    let live = LIVE.lock().await;
    let Some(live) = live.as_ref() else { return Err("语音还没接通".into()) };
    live.tx.send(Cmd::Nudge(sentence)).await.map_err(|_| "语音连接已断开".to_string())
}

#[tauri::command]
pub async fn rime_prism_close() -> Result<(), String> {
    let mut live = LIVE.lock().await;
    if let Some(previous) = live.take() {
        let _ = previous.tx.try_send(Cmd::Close);
    }
    Ok(())
}

async fn run_prism(
    key: String,
    mut commands: tokio::sync::mpsc::Receiver<Cmd>,
    channel: tauri::ipc::Channel<Value>,
    ready: tokio::sync::oneshot::Sender<Result<(), String>>,
) {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    let mut socket = match connect_prism(&key).await {
        Ok(socket) => socket,
        Err(error) => {
            let _ = ready.send(Err(error.clone()));
            emit(&channel, json!({ "kind": "error", "message": error }));
            return;
        }
    };
    let mut ready = Some(ready);
    let mut idle = false;
    let mut item_id = String::new();
    let mut nudges: std::collections::VecDeque<String> = std::collections::VecDeque::new();
    let mut seq = 0u64;
    let next_id = |seq: &mut u64| {
        *seq += 1;
        format!("evt_{seq}")
    };

    let setup = json!({
        "type": "session.update",
        "event_id": "evt_setup",
        "session": { "voice": VOICE, "instructions": INSTRUCTIONS }
    });

    let result = async {
        loop {
            tokio::select! {
                command = commands.recv() => {
                    let Some(command) = command else { return Ok::<(), String>(()) };
                    match command {
                        Cmd::Close => return Ok(()),
                        Cmd::Audio(audio) => {
                            if ready.is_some() { continue; }
                            let event = json!({ "type": "input_audio_buffer.append", "audio": audio });
                            socket.send(Message::text(event.to_string())).await.map_err(|error| error.to_string())?;
                        }
                        Cmd::Truncate { item_id, audio_end_ms } => {
                            if item_id.is_empty() { continue; }
                            let event = json!({
                                "type": "conversation.item.truncate",
                                "event_id": next_id(&mut seq),
                                "item_id": item_id,
                                "content_index": 0,
                                "audio_end_ms": audio_end_ms
                            });
                            socket.send(Message::text(event.to_string())).await.map_err(|error| error.to_string())?;
                        }
                        Cmd::Nudge(text) => {
                            if idle {
                                idle = false;
                                send_nudge(&mut socket, &next_id(&mut seq), &text).await?;
                            } else {
                                nudges.push_back(text);
                            }
                        }
                    }
                }
                incoming = socket.next() => {
                    let Some(incoming) = incoming else { return Err("Prism 连接已断开".into()) };
                    let message = incoming.map_err(|error| error.to_string())?;
                    match message {
                        Message::Ping(bytes) => { socket.send(Message::Pong(bytes)).await.map_err(|error| error.to_string())?; }
                        Message::Text(text) => {
                            let Ok(event) = serde_json::from_str::<Value>(&text) else { continue };
                            let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
                            if kind == "session.created" {
                                socket.send(Message::text(setup.to_string())).await.map_err(|error| error.to_string())?;
                            } else if kind == "session.updated" && ready.is_some() {
                                if let Some(sender) = ready.take() { let _ = sender.send(Ok(())); }
                                emit(&channel, json!({ "kind": "ready" }));
                            } else if kind == "error" {
                                let message = event.pointer("/error/message").and_then(Value::as_str).unwrap_or("Prism 拒绝了这次请求").to_string();
                                if let Some(sender) = ready.take() {
                                    let _ = sender.send(Err(message.clone()));
                                    return Err(message);
                                }
                                emit(&channel, json!({ "kind": "error", "message": message }));
                            } else if kind == "input_audio_buffer.speech_started" {
                                emit(&channel, json!({ "kind": "speech_started", "itemId": item_id }));
                            } else if kind == "conversation.item.input_audio_transcription.completed" {
                                let said = text_of(event.get("transcript"));
                                if !said.is_empty() { emit(&channel, json!({ "kind": "transcript", "text": said })); }
                            } else if kind == "response.output_item.added" {
                                if let Some(id) = event.pointer("/item/id").and_then(Value::as_str) { item_id = id.to_owned(); }
                            } else if kind == "response.audio.delta" {
                                let audio = text_of(event.get("delta"));
                                if !audio.is_empty() { emit(&channel, json!({ "kind": "audio", "audio": audio, "itemId": item_id })); }
                            } else if kind == "response.text.done" {
                                let said = text_of(event.get("text"));
                                if !said.is_empty() { emit(&channel, json!({ "kind": "reply", "text": said })); }
                            } else if kind == "prism.typed_input.ready" {
                                idle = true;
                                if let Some(text) = nudges.pop_front() {
                                    idle = false;
                                    send_nudge(&mut socket, &next_id(&mut seq), &text).await?;
                                }
                                emit(&channel, json!({ "kind": "idle" }));
                            }
                        }
                        Message::Close(_) => return Err("Prism 把通话关掉了".into()),
                        _ => {}
                    }
                }
            }
        }
    };

    if let Err(error) = result.await {
        emit(&channel, json!({ "kind": "error", "message": error }));
    }
    emit(&channel, json!({ "kind": "closed" }));
    let mut live = LIVE.lock().await;
    *live = None;
}

async fn send_nudge(socket: &mut Socket, id: &str, text: &str) -> Result<(), String> {
    use futures_util::SinkExt;
    use tokio_tungstenite::tungstenite::Message;
    let event = json!({
        "type": "response.create",
        "event_id": id,
        "response": {
            "metadata": {
                "prism_cause": "proactive",
                "prism_instruction": format!("Say this aloud in one short sentence, then stop: {text}")
            }
        }
    });
    socket.send(Message::text(event.to_string())).await.map_err(|error| error.to_string())
}
