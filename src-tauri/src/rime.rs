//! Rime 语音：TTS 与 STT，只服务「语音 Agent」这一页。
//!
//! 和 `speech.rs`（composer 的听写按钮）刻意分开，是因为两者解决的不是同一个问题：
//! `speech.rs` 把一段录音转成**要塞进输入框的文字**，是一次性的；这里要把一整轮对话
//! 接起来——听一句、交给 Pi、把 Pi 的回答**说出来**，而且随时能被用户打断。共用一份
//! 配置会让两边的默认值互相打架（一个要中文听写，一个要 Rime 的十种语言），所以凭证
//! 各自独立：`auth.json` 里的 provider 是 `rime`，配置文件是 `rime.json`。
//!
//! 只有两个传输：
//!
//! * **TTS** — `POST https://coda.api.rime.ai/`（或 `mist.api.rime.ai`），
//!   `Accept: audio/mpeg`。前端按句调用，拿回一段 mp3 立刻播；整段一次性返回就够，
//!   因为句子本来就短，首字延迟由模型的 TTFA 决定，不靠传输层。
//! * **STT** — `wss://stt.api.rime.ai/ws`。浏览器的 `WebSocket` 构造函数**不能**设
//!   `Authorization` 头，所以这一跳必须在 Rust 里做；协议是「一条连接 = 一句话」，
//!   正好对上「用户说完一句 → 发一条 prompt」的轮次。
//!
//! STT 只支持 `en` / `es`（Rime 的现状，不是这里的限制），所以 `sttLang` 只有两个值；
//! TTS 十种语言则由 `lang` 单独选。两者都缺省 `en`。

use base64::Engine;
use serde_json::{json, Map, Value};
use std::path::PathBuf;
use std::pin::Pin;

use crate::bridge;

/// `auth.json` 里存 Rime 密钥的 provider id。
pub const DEFAULT_PROVIDER_ID: &str = "rime";

const CODA_URL: &str = "https://coda.api.rime.ai/";
const MIST_URL: &str = "https://mist.api.rime.ai/";
const STT_HOST: &str = "stt.api.rime.ai";
const STT_PATH: &str = "/ws";

/// Coda 是旗舰（音质），Mist v3 是最低延迟。两者都只在这一个页面里被选。
const MODELS: [&str; 2] = ["coda", "mistv3"];
/// Coda 的云端语言。中文不在里面——这是选 Rime 时就要接受的现实。
const LANGS: [&str; 10] = ["en", "ar", "nl", "fr", "de", "hi", "it", "ja", "pt", "es"];
/// STT 只有这两个，且不自动识别，必须显式声明。
const STT_LANGS: [&str; 2] = ["en", "es"];

const DEFAULT_MODEL: &str = "coda";
const DEFAULT_SPEAKER: &str = "astra";
const DEFAULT_LANG: &str = "en";

/// 复用一个 client，别按句新建：每句一次 TLS 握手会把首字延迟再抬几十毫秒，
/// 而这正好是这个页面唯一在乎的指标。
static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();

fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(reqwest::Client::new)
}

/// 一句话的上限。超过这个长度的「一句话」多半是前端断句器出了问题，不是用户说了这么长。
const MAX_TTS_CHARS: usize = 1_200;
/// 16 MiB 是 Rime 一句话的硬上限（16 kHz 单声道 PCM16 约 8.7 分钟）。
const MAX_STT_BYTES: usize = 16 * 1024 * 1024;
/// 每个 `audio` 消息解码后不得超过 64 KiB；32 KiB 留了一半余量。
const STT_CHUNK_BYTES: usize = 32 * 1024;

fn config_path() -> Result<PathBuf, String> {
    Ok(bridge::agent_dir()?.join("rime.json"))
}

fn trimmed(value: &Value) -> Option<String> {
    let text = value.as_str()?.trim();
    (!text.is_empty()).then(|| text.to_owned())
}

fn valid_speaker(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
}

fn read_stored() -> Value {
    config_path()
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .map(|value| normalized(&value))
        .unwrap_or_else(|| normalized(&Value::Null))
}

fn auth_json() -> Result<Value, String> {
    let dir = bridge::agent_dir()?;
    let text = std::fs::read_to_string(dir.join("auth.json")).unwrap_or_else(|_| "{}".into());
    serde_json::from_str::<Value>(&text).map_err(|_| "Pi 的 auth.json 不是合法 JSON".to_string())
}

fn api_key() -> Result<String, String> {
    let auth = auth_json()?;
    bridge::stored_api_key(&auth, DEFAULT_PROVIDER_ID)
        .ok_or_else(|| "还没有配置 Rime API key（在语音页填一次即可）".to_string())
}

/// 只保留已知键，并把缺省值补齐——读到什么就是什么，不让半份文件决定行为。
fn normalized(value: &Value) -> Value {
    let source = value.as_object();
    let pick = |key: &str| source.and_then(|object| object.get(key)).and_then(Value::as_str);
    let model = pick("model").filter(|m| MODELS.contains(m)).unwrap_or(DEFAULT_MODEL);
    let lang = pick("lang").filter(|l| LANGS.contains(l)).unwrap_or(DEFAULT_LANG);
    let stt_lang = pick("sttLang").filter(|l| STT_LANGS.contains(l)).unwrap_or("en");
    let speaker = pick("speaker")
        .filter(|s| valid_speaker(s))
        .unwrap_or(DEFAULT_SPEAKER);
    json!({
        "model": model,
        "speaker": speaker,
        "lang": lang,
        "sttLang": stt_lang,
        "configured": source.is_some_and(|object| !object.is_empty()),
    })
}

/// 配置 + 一个「这把钥匙到底有没有」的结论，页面上要同时显示这两件事。
#[tauri::command]
pub async fn rime_config() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut config = read_stored();
        let has_credential = auth_json()
            .ok()
            .and_then(|auth| bridge::stored_api_key(&auth, DEFAULT_PROVIDER_ID))
            .is_some();
        config["hasCredential"] = Value::Bool(has_credential);
        config["models"] = json!(MODELS);
        config["langs"] = json!(LANGS);
        config["sttLangs"] = json!(STT_LANGS);
        Ok(config)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// 校验一份 patch。未知模型/语言在这里就被拒绝，省得把错误留到请求时才暴露。
fn validate_patch(input: &Value) -> Result<Value, String> {
    let object = input
        .as_object()
        .ok_or_else(|| "语音配置必须是一个对象".to_string())?;
    let mut out = Map::new();
    for (key, value) in object {
        if value.is_null() {
            out.insert(key.clone(), Value::Null);
            continue;
        }
        let text = trimmed(value).ok_or_else(|| format!("{key} 不能是空字符串；传 null 表示清除"))?;
        match key.as_str() {
            "model" if !MODELS.contains(&text.as_str()) => {
                return Err(format!("model 只支持 {}", MODELS.join(" / ")));
            }
            "lang" if !LANGS.contains(&text.as_str()) => {
                return Err(format!("lang 只支持 {}", LANGS.join(" / ")));
            }
            "sttLang" if !STT_LANGS.contains(&text.as_str()) => {
                return Err("sttLang 只支持 en / es".into());
            }
            "speaker" if !valid_speaker(&text) => {
                return Err("speaker 只能包含字母、数字、_、-、.".into());
            }
            "model" | "lang" | "sttLang" | "speaker" => {}
            _ => continue,
        }
        out.insert(key.clone(), Value::String(text));
    }
    Ok(Value::Object(out))
}

/// `null` 删除，缺省保留：写一次就是一个补丁，不会把别的字段抹掉。
fn merge(stored: &Value, patch: &Value) -> Value {
    let mut out = stored.as_object().cloned().unwrap_or_default();
    out.remove("configured");
    if let Some(object) = patch.as_object() {
        for (key, value) in object {
            if value.is_null() {
                out.remove(key);
            } else {
                out.insert(key.clone(), value.clone());
            }
        }
    }
    Value::Object(out)
}

#[tauri::command]
pub async fn save_rime_config(config: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let patch = validate_patch(&config)?;
        let merged = merge(&read_stored(), &patch);
        let path = config_path()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| format!("无法创建 Pi 配置目录：{error}"))?;
        }
        std::fs::write(
            &path,
            serde_json::to_string_pretty(&merged).map_err(|error| error.to_string())? + "\n",
        )
        .map_err(|error| format!("写入 {} 失败：{error}", path.display()))?;
        Ok(normalized(&merged))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn save_rime_api_key(api_key: Option<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        bridge::store_provider_api_key(DEFAULT_PROVIDER_ID, api_key.as_deref())?;
        let has_credential = auth_json()
            .ok()
            .and_then(|auth| bridge::stored_api_key(&auth, DEFAULT_PROVIDER_ID))
            .is_some();
        Ok(json!({"hasCredential": has_credential}))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// 说一句。按句调用，所以这里不做流式：一句 mp3 拿到就播，比攒流简单也更快出声。
/// `format: "pcm"` 要裸 PCM16（`Accept: audio/L16`）而不是 mp3。
///
/// mp3 有两个额外成本：服务端要编码、客户端要解码，而播放器还得等**整段**文件才出声。
/// PCM 拿来就能进 Web Audio 的 buffer，几段之间还能排到同一条时间轴上——句子之间
/// 的缝就是这么消失的。
#[tauri::command]
pub async fn rime_tts(text: String, speaker: Option<String>, format: Option<String>) -> Result<Value, String> {
    let text = text.trim().to_owned();
    if text.is_empty() {
        return Err("要合成的文本是空的".into());
    }
    if text.chars().count() > MAX_TTS_CHARS {
        return Err("这句话太长，断句器应该先把它切开".into());
    }
    let key = api_key()?;
    let config = read_stored();
    let model = config["model"].as_str().unwrap_or(DEFAULT_MODEL).to_owned();
    let lang = config["lang"].as_str().unwrap_or(DEFAULT_LANG).to_owned();
    let voice = speaker
        .as_deref()
        .map(str::trim)
        .filter(|value| valid_speaker(value))
        .unwrap_or_else(|| config["speaker"].as_str().unwrap_or(DEFAULT_SPEAKER))
        .to_owned();

    let url = if model == "mistv3" { MIST_URL } else { CODA_URL };
    let mut body = json!({
        "speaker": voice,
        "text": text,
        "lang": lang,
    });
    // Coda 的端点自己就是 coda；Mist v3 必须显式声明 modelId，否则会被默认值接走。
    if model == "mistv3" {
        body["modelId"] = json!("mistv3");
    }

    let pcm = format.as_deref() == Some("pcm");
    let response = client()
        .post(url)
        .header("Authorization", format!("Bearer {key}"))
        .header("Accept", if pcm { "audio/L16" } else { "audio/mpeg" })
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("连接 Rime 失败：{error}"))?;

    let status = response.status();
    if !status.is_success() {
        let detail = response.text().await.unwrap_or_default();
        return Err(format!(
            "Rime TTS 返回 {status}：{}",
            truncate(detail.trim())
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("读取音频失败：{error}"))?;
    if bytes.is_empty() {
        return Err("Rime 返回了空音频".into());
    }
    Ok(json!({
        "audio": base64::engine::general_purpose::STANDARD.encode(&bytes),
        "mimeType": if pcm { "audio/pcm" } else { "audio/mpeg" },
        // Coda 产出 24kHz，Mist 是 22.05kHz；PCM 没有容器头，采样率只能由调用方带上。
        "sampleRate": if model == "mistv3" { 22_050 } else { 24_000 },
        "model": model,
        "speaker": voice,
        "lang": lang,
    }))
}

fn truncate(text: &str) -> String {
    if text.len() <= 400 {
        return text.to_owned();
    }
    let mut cut = 400;
    while cut > 0 && !text.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}…", &text[..cut])
}

type SttSocket = tokio_tungstenite::WebSocketStream<tokio_openssl::SslStream<tokio::net::TcpStream>>;

/// 通用 WS 连接：给 STT 和 TTS 共用（都要求升级请求里带 `Authorization`）。
async fn connect_ws(host: &str, path_and_query: &str, key: &str, subprotocol: Option<&str>) -> Result<SttSocket, String> {
    use openssl::ssl::{SslConnector, SslMethod};
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    let tcp = tokio::net::TcpStream::connect((host, 443u16))
        .await
        .map_err(|error| format!("连接 {host} 失败：{error}"))?;
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
        .into_ssl(host)
        .map_err(|error| error.to_string())?;
    let mut tls = tokio_openssl::SslStream::new(ssl, tcp).map_err(|error| error.to_string())?;
    Pin::new(&mut tls)
        .connect()
        .await
        .map_err(|error| format!("{host} TLS 握手失败：{error}"))?;

    let mut request = format!("wss://{host}{path_and_query}")
        .into_client_request()
        .map_err(|error| format!("升级请求无效：{error}"))?;
    let mut header = |name: &'static str, value: &str| -> Result<(), String> {
        let parsed = tokio_tungstenite::tungstenite::http::HeaderValue::from_str(value)
            .map_err(|error| format!("请求头无效：{error}"))?;
        request.headers_mut().insert(name, parsed);
        Ok(())
    };
    header("Authorization", &format!("Bearer {key}"))?;
    if let Some(protocol) = subprotocol {
        header("Sec-WebSocket-Protocol", protocol)?;
    }

    let (socket, _) = tokio_tungstenite::client_async(request, tls)
        .await
        .map_err(|error| format!("{host} 升级失败：{error}"))?;
    Ok(socket)
}

/// TTS 流式：把 LLM 吐出来的文字边送边收音频。
///
/// `/ws` 这个端点收的是**裸文本**，`segment=immediate` 让它不等整句就开始合成，
/// 回来的音频是 raw PCM——正好能直接排进 Web Audio 的时间轴。这才是"实时"：
/// 第一段音频通常在首字到达后 100–300ms 就回来了，而不是等一句话写完、再等一次
/// 完整请求往返。
enum TtsCommand {
    Text(String),
    /// `<EOS>`：把剩下的合成完再关连接。
    Finish,
    /// `<CLEAR>`：用户插话，丢弃缓冲并停止。
    Cancel,
}

struct TtsStream {
    commands: tokio::sync::mpsc::Sender<TtsCommand>,
}

static TTS_STREAMS: std::sync::LazyLock<tokio::sync::Mutex<std::collections::HashMap<String, TtsStream>>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(std::collections::HashMap::new()));

const TTS_WS_HOST: &str = "users-ws.rime.ai";
const TTS_SAMPLE_RATE: u32 = 24_000;

async fn run_tts_stream(
    key: String,
    model: String,
    lang: String,
    speaker: String,
    mut commands: tokio::sync::mpsc::Receiver<TtsCommand>,
    channel: tauri::ipc::Channel<Value>,
) {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    let query = format!(
        "/ws?speaker={speaker}&modelId={model}&lang={lang}&audioFormat=pcm&samplingRate={TTS_SAMPLE_RATE}&segment=immediate"
    );
    let mut socket = match connect_ws(TTS_WS_HOST, &query, &key, None).await {
        Ok(socket) => socket,
        Err(error) => {
            let _ = channel.send(json!({"error": error}));
            return;
        }
    };

    let mut index = 0u64;
    loop {
        tokio::select! {
            command = commands.recv() => {
                match command {
                    Some(TtsCommand::Text(text)) => {
                        if socket.send(Message::text(text)).await.is_err() {
                            let _ = channel.send(json!({"error": "TTS 连接已断开"}));
                            return;
                        }
                    }
                    Some(TtsCommand::Finish) => {
                        let _ = socket.send(Message::text("<EOS>")).await;
                    }
                    Some(TtsCommand::Cancel) | None => {
                        let _ = socket.send(Message::text("<CLEAR>")).await;
                        let _ = channel.send(json!({"done": true}));
                        return;
                    }
                }
            }
            message = socket.next() => {
                match message {
                    Some(Ok(Message::Binary(bytes))) => {
                        // PCM：服务端可能在消息边界切断采样，偶数化交给前端处理。
                        let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
                        let _ = channel.send(json!({"audio": encoded, "index": index}));
                        index += 1;
                    }
                    Some(Ok(Message::Text(text))) => {
                        // 服务端偶尔回一行文本（例如参数错误），原样带上去。
                        let _ = channel.send(json!({"notice": text.to_string()}));
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        let _ = channel.send(json!({"done": true}));
                        return;
                    }
                    Some(Ok(_)) => {}
                    Some(Err(_)) => {
                        let _ = channel.send(json!({"done": true}));
                        return;
                    }
                }
            }
        }
    }
}

#[tauri::command]
pub async fn rime_tts_stream(on_audio: tauri::ipc::Channel<Value>) -> Result<Value, String> {
    let key = api_key()?;
    let config = read_stored();
    let model = config["model"].as_str().unwrap_or(DEFAULT_MODEL).to_owned();
    let lang = config["lang"].as_str().unwrap_or(DEFAULT_LANG).to_owned();
    let speaker = config["speaker"].as_str().unwrap_or(DEFAULT_SPEAKER).to_owned();
    let id = uuid::Uuid::new_v4().to_string();
    let (command_tx, command_rx) = tokio::sync::mpsc::channel(256);
    tauri::async_runtime::spawn(run_tts_stream(key, model.clone(), lang.clone(), speaker.clone(), command_rx, on_audio));
    TTS_STREAMS.lock().await.insert(id.clone(), TtsStream { commands: command_tx });
    Ok(json!({"id": id, "sampleRate": TTS_SAMPLE_RATE, "model": model, "speaker": speaker, "lang": lang}))
}

#[tauri::command]
pub async fn rime_tts_send(id: String, text: String) -> Result<(), String> {
    let streams = TTS_STREAMS.lock().await;
    let Some(stream) = streams.get(&id) else {
        return Err("这条朗读流已经结束".into());
    };
    stream
        .commands
        .send(TtsCommand::Text(text))
        .await
        .map_err(|_| "朗读流已经中断".to_string())
}

#[tauri::command]
pub async fn rime_tts_finish(id: String) -> Result<(), String> {
    let streams = TTS_STREAMS.lock().await;
    if let Some(stream) = streams.get(&id) {
        let _ = stream.commands.send(TtsCommand::Finish).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn rime_tts_cancel(id: String) -> Result<(), String> {
    let stream = {
        let mut streams = TTS_STREAMS.lock().await;
        streams.remove(&id)
    };
    if let Some(stream) = stream {
        let _ = stream.commands.send(TtsCommand::Cancel).await;
    }
    Ok(())
}

/// 打开 STT 连接。TLS 用 OpenSSL，和 relay 是同一套理由：系统根证书要显式加载，
/// 而且升级请求要带 `Authorization` 头——这是浏览器 WebSocket 做不到的那件事。
async fn connect_stt(key: &str) -> Result<SttSocket, String> {
    use openssl::ssl::{SslConnector, SslMethod};
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    let tcp = tokio::net::TcpStream::connect((STT_HOST, 443u16))
        .await
        .map_err(|error| format!("连接 Rime STT 失败：{error}"))?;
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
        .into_ssl(STT_HOST)
        .map_err(|error| error.to_string())?;
    let mut tls = tokio_openssl::SslStream::new(ssl, tcp).map_err(|error| error.to_string())?;
    Pin::new(&mut tls)
        .connect()
        .await
        .map_err(|error| format!("Rime STT TLS 握手失败：{error}"))?;

    let mut request = format!("wss://{STT_HOST}{STT_PATH}")
        .into_client_request()
        .map_err(|error| format!("STT 升级请求无效：{error}"))?;
    let header = |name: &'static str, value: &str| -> Result<_, String> {
        tokio_tungstenite::tungstenite::http::HeaderValue::from_str(value)
            .map(|value| (name, value))
            .map_err(|error| format!("请求头无效：{error}"))
    };
    let (name, value) = header("Authorization", &format!("Bearer {key}"))?;
    request.headers_mut().insert(name, value);
    // 明确要 JSON 帧：默认也是它，但写出来才不会因为以后改默认值而静默变成 protobuf。
    let (name, value) = header("Sec-WebSocket-Protocol", "rime.v1.json")?;
    request.headers_mut().insert(name, value);

    let (socket, _) = tokio_tungstenite::client_async(request, tls)
        .await
        .map_err(|error| format!("Rime STT 升级失败：{error}"))?;
    Ok(socket)
}

/// 把一整句录音转成文字（一次性）。
///
/// 这是**兜底**路径：语音页正常走流式（`rime_stt_open/push/finish`），因为
/// 等静音结束再上传、再等握手，光这一段就要多花半秒以上。这里留着是为了
/// 流式打不开时还能用。
#[tauri::command]
pub async fn rime_stt(audio_base64: String) -> Result<Value, String> {
    use futures_util::SinkExt;
    use tokio_tungstenite::tungstenite::Message;

    let audio = base64::engine::general_purpose::STANDARD
        .decode(audio_base64.trim())
        .map_err(|error| format!("音频不是合法 base64：{error}"))?;
    if audio.is_empty() {
        return Err("录音是空的".into());
    }
    if audio.len() > MAX_STT_BYTES {
        return Err("这段录音太长，一句话最多约 8 分钟".into());
    }
    if audio.len() % 2 != 0 {
        return Err("PCM16 的字节数必须是偶数".into());
    }

    let key = api_key()?;
    let language = stt_language();
    let mut socket = connect_stt(&key).await?;
    send_start(&mut socket, &language).await?;
    for chunk in audio.chunks(STT_CHUNK_BYTES) {
        send_audio(&mut socket, chunk).await?;
    }
    socket
        .send(Message::text(json!({"end": {}}).to_string()))
        .await
        .map_err(|error| format!("发送 end 失败：{error}"))?;
    let text = read_done(&mut socket, &language).await?;
    Ok(json!({
        "text": text,
        "noSpeech": text.is_empty(),
        "language": language,
    }))
}

fn stt_language() -> String {
    read_stored()
        .get("sttLang")
        .and_then(Value::as_str)
        .unwrap_or("en")
        .to_owned()
}

async fn send_start(socket: &mut SttSocket, language: &str) -> Result<(), String> {
    use futures_util::SinkExt;
    use tokio_tungstenite::tungstenite::Message;
    let start = json!({
        "start": {
            "outputContract": "STREAMING_OUTPUT_CONTRACT_REVISED_HYPOTHESES",
            "language": language,
            "mode": "TRANSCRIPTION_MODE_WRITTEN",
        }
    });
    socket
        .send(Message::text(start.to_string()))
        .await
        .map_err(|error| format!("发送 start 失败：{error}"))
}

async fn send_audio(socket: &mut SttSocket, audio: &[u8]) -> Result<(), String> {
    use futures_util::SinkExt;
    use tokio_tungstenite::tungstenite::Message;
    for chunk in audio.chunks(STT_CHUNK_BYTES) {
        let message = json!({
            "audio": base64::engine::general_purpose::STANDARD.encode(chunk),
        });
        socket
            .send(Message::text(message.to_string()))
            .await
            .map_err(|error| format!("发送音频失败：{error}"))?;
    }
    Ok(())
}

/// 读到终态为止。`done` 是唯一的成功终态；`error` / `cancelled` / 断连都是失败。
async fn read_done(socket: &mut SttSocket, language: &str) -> Result<String, String> {
    use futures_util::StreamExt;
    use tokio_tungstenite::tungstenite::Message;

    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err("Rime STT 超时，没有拿到终态".into());
        }
        let next = tokio::time::timeout(remaining, socket.next()).await;
        let message = match next {
            Err(_) => return Err("Rime STT 超时，没有拿到终态".into()),
            Ok(None) => return Err("Rime STT 连接提前关闭，没有拿到终态".into()),
            Ok(Some(Err(error))) => return Err(format!("Rime STT 连接出错：{error}")),
            Ok(Some(Ok(message))) => message,
        };
        let text = match message {
            Message::Text(text) => text.to_string(),
            Message::Close(_) => return Err("Rime STT 连接提前关闭，没有拿到终态".into()),
            _ => continue,
        };
        let Ok(event) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if let Some(done) = event.get("done") {
            let transcript = done["text"].as_str().unwrap_or_default().trim().to_owned();
            let _ = language;
            return Ok(transcript);
        }
        if let Some(error) = event.get("error") {
            return Err(format!(
                "Rime STT 失败（{}）：{}",
                error["kind"].as_str().unwrap_or("unknown"),
                error["message"].as_str().unwrap_or("没有说明")
            ));
        }
        if event.get("cancelled").is_some() {
            return Err("Rime STT 被取消".into());
        }
    }
}

/// 流式 STT：连接和握手在**用户还在说话的时候**就已经发生，静音结束时只剩一个 `end`。
///
/// 这是一次性版本省不掉的那半秒：TLS + 升级 + `started` 大约 200–500ms，上传整段
/// PCM 又是一段。放到说话期间做，用户感知到的延迟就只剩「转写收尾 + LLM」。
enum SttCommand {
    Audio(Vec<u8>),
    End,
    Cancel,
}

struct SttStream {
    commands: tokio::sync::mpsc::Sender<SttCommand>,
    result: tokio::sync::oneshot::Receiver<Result<String, String>>,
}

static STREAMS: std::sync::LazyLock<tokio::sync::Mutex<std::collections::HashMap<String, SttStream>>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(std::collections::HashMap::new()));

async fn run_stream(
    key: String,
    language: String,
    mut commands: tokio::sync::mpsc::Receiver<SttCommand>,
    result: tokio::sync::oneshot::Sender<Result<String, String>>,
) {
    use futures_util::SinkExt;
    use tokio_tungstenite::tungstenite::Message;

    let mut socket = match connect_stt(&key).await {
        Ok(socket) => socket,
        Err(error) => {
            let _ = result.send(Err(error));
            return;
        }
    };
    if let Err(error) = send_start(&mut socket, &language).await {
        let _ = result.send(Err(error));
        return;
    }
    while let Some(command) = commands.recv().await {
        match command {
            SttCommand::Audio(audio) => {
                if let Err(error) = send_audio(&mut socket, &audio).await {
                    let _ = result.send(Err(error));
                    return;
                }
            }
            SttCommand::End => {
                if let Err(error) = socket.send(Message::text(json!({"end": {}}).to_string())).await {
                    let _ = result.send(Err(format!("发送 end 失败：{error}")));
                    return;
                }
                let _ = result.send(read_done(&mut socket, &language).await);
                return;
            }
            SttCommand::Cancel => {
                let _ = socket
                    .send(Message::text(json!({"cancel": {}}).to_string()))
                    .await;
                let _ = result.send(Err("Rime STT 被取消".into()));
                return;
            }
        }
    }
    // 命令通道被关掉却没有 End：调用方放弃了这句话。
    let _ = result.send(Err("Rime STT 被取消".into()));
}

/// 开一条流。返回时**还没有**连上——握手在后台做，前端可以在用户说话时就开始推音频。
#[tauri::command]
pub async fn rime_stt_open() -> Result<Value, String> {
    let key = api_key()?;
    let language = stt_language();
    let id = uuid::Uuid::new_v4().to_string();
    let (command_tx, command_rx) = tokio::sync::mpsc::channel(256);
    let (result_tx, result_rx) = tokio::sync::oneshot::channel();
    tauri::async_runtime::spawn(run_stream(key, language.clone(), command_rx, result_tx));
    STREAMS.lock().await.insert(
        id.clone(),
        SttStream {
            commands: command_tx,
            result: result_rx,
        },
    );
    Ok(json!({"id": id, "language": language}))
}

#[tauri::command]
pub async fn rime_stt_push(id: String, audio_base64: String) -> Result<(), String> {
    let audio = base64::engine::general_purpose::STANDARD
        .decode(audio_base64.trim())
        .map_err(|error| format!("音频不是合法 base64：{error}"))?;
    if audio.is_empty() {
        return Ok(());
    }
    let streams = STREAMS.lock().await;
    let Some(stream) = streams.get(&id) else {
        return Err("这条流已经结束了".into());
    };
    stream
        .commands
        .send(SttCommand::Audio(audio))
        .await
        .map_err(|_| "Rime STT 流已经中断".to_string())
}

#[tauri::command]
pub async fn rime_stt_finish(id: String) -> Result<Value, String> {
    let stream = {
        let mut streams = STREAMS.lock().await;
        streams.remove(&id)
    };
    let Some(stream) = stream else {
        return Err("这条流已经结束了".into());
    };
    stream
        .commands
        .send(SttCommand::End)
        .await
        .map_err(|_| "Rime STT 流已经中断".to_string())?;
    let text = tokio::time::timeout(std::time::Duration::from_secs(30), stream.result)
        .await
        .map_err(|_| "Rime STT 超时".to_string())?
        .map_err(|_| "Rime STT 没有返回结果".to_string())??;
    Ok(json!({
        "text": text,
        "noSpeech": text.is_empty(),
    }))
}

#[tauri::command]
pub async fn rime_stt_abort(id: String) -> Result<(), String> {
    let stream = {
        let mut streams = STREAMS.lock().await;
        streams.remove(&id)
    };
    if let Some(stream) = stream {
        let _ = stream.commands.send(SttCommand::Cancel).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn saved(source: Value, patch: Value) -> Value {
        let merged = merge(&normalized(&source), &validate_patch(&patch).expect("patch 应当合法"));
        normalized(&merged)
    }

    #[test]
    fn defaults_are_coda_astra_english() {
        let config = normalized(&Value::Null);
        assert_eq!(config["model"], json!("coda"));
        assert_eq!(config["speaker"], json!("astra"));
        assert_eq!(config["lang"], json!("en"));
        assert_eq!(config["sttLang"], json!("en"));
        assert_eq!(config["configured"], json!(false));
    }

    #[test]
    fn an_unknown_model_or_language_is_refused_instead_of_silently_defaulted() {
        assert!(validate_patch(&json!({"model": "arcana"})).is_err());
        assert!(validate_patch(&json!({"lang": "zh"})).is_err());
        assert!(validate_patch(&json!({"sttLang": "zh"})).is_err());
    }

    #[test]
    fn a_write_is_a_patch_and_null_clears() {
        let stored = saved(json!({"speaker": "luna"}), json!({"model": "mistv3"}));
        assert_eq!(stored["speaker"], json!("luna"));
        assert_eq!(stored["model"], json!("mistv3"));
        let cleared = merge(&stored, &json!({"speaker": null}));
        assert_eq!(normalized(&cleared)["speaker"], json!("astra"));
    }

    #[test]
    fn unknown_keys_are_dropped_rather_than_stored() {
        let stored = saved(json!({}), json!({"apiKey": "leak"}));
        assert!(stored.get("apiKey").is_none());
    }

    #[test]
    fn a_read_never_trusts_a_hand_edited_file() {
        let config = normalized(&json!({"model": "gpt", "lang": "zh", "speaker": "a b"}));
        assert_eq!(config["model"], json!("coda"));
        assert_eq!(config["lang"], json!("en"));
        assert_eq!(config["speaker"], json!("astra"));
    }

    #[test]
    fn error_bodies_stay_small_and_on_a_char_boundary() {
        let cut = truncate(&"汉".repeat(400));
        assert!(cut.len() <= 404);
        assert!(std::str::from_utf8(cut.as_bytes()).is_ok());
        assert_eq!(truncate("ok"), "ok");
    }
}
