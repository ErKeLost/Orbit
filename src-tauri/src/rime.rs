//! Rime 语音：TTS 与 STT，只服务「语音 Agent」这一页。
//!
//! 和 `speech.rs`（composer 的听写按钮）刻意分开，是因为两者解决的不是同一个问题：
//! `speech.rs` 把一段录音转成**要塞进输入框的文字**，是一次性的；这里要把一整轮对话
//! 接起来——听一句、交给 Pi、把 Pi 的回答**说出来**，而且随时能被用户打断。共用一份
//! 配置会让两边的默认值互相打架（一个要中文听写，一个要 Rime 的十种语言），所以凭证
//! 各自独立：`auth.json` 里的 provider 是 `rime`，配置文件是 `rime.json`。
//!
//! 实时对话使用 WebSocket v1：TTS 复用连接，每轮独立 contextId；STT 每句一条连接。
//! 密钥只在 Rust 端读取。HTTP 合成保留给单段导出，实时播放直接消费 PCM 分片。
//! Rime STT 当前仅支持 en / es；不会改用其他语音供应商。

use base64::Engine;
use serde_json::{json, Map, Value};
use std::path::PathBuf;
use std::pin::Pin;

use crate::bridge;
mod error;
use error::RimeError;

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
static CONFIG_WRITE: std::sync::Mutex<()> = std::sync::Mutex::new(());

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

fn context_terms(value: &Value) -> Result<Vec<String>, String> {
    if value.is_null() { return Ok(Vec::new()); }
    let array = value.as_array().ok_or("识别关键词必须是字符串数组")?;
    let mut terms = Vec::new();
    for value in array {
        let term = value.as_str().map(str::trim).filter(|term| !term.is_empty()).ok_or("识别关键词不能为空")?;
        if term.contains("<|") || term.contains("|>") || term.chars().any(char::is_control) { return Err("识别关键词不能包含控制标记".into()); }
        terms.push(term.to_owned());
    }
    if terms.join(", ").len() > 1024 { return Err("识别关键词合计不能超过 1024 UTF-8 字节".into()); }
    Ok(terms)
}

fn tts_sample_rate(model: &str) -> u32 { if model == "mistv3" { 22_050 } else { 24_000 } }

fn custom_lexicon(value: &Value) -> Result<Vec<Value>, String> {
    if value.is_null() { return Ok(Vec::new()); }
    let entries = value.as_array().filter(|entries| entries.len() <= 500).ok_or("发音词典最多包含 500 项")?;
    let mut result = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for entry in entries {
        let spelling = trimmed(&entry["spelling"]).ok_or("发音词典的词语不能为空")?;
        let pronunciation = trimmed(&entry["pronunciation"]).ok_or("发音词典的音标不能为空")?;
        if spelling.chars().any(char::is_control) || !pronunciation.is_ascii() || pronunciation.chars().any(char::is_control) {
            return Err("词语不能包含控制字符，发音必须使用以空格分隔的 ASCII X-SAMPA 音标".into());
        }
        if !seen.insert(spelling.to_lowercase()) { return Err(format!("发音词典含有重复词语：{spelling}")); }
        result.push(json!({"spelling":spelling,"pronunciation":pronunciation}));
    }
    // The complete WebSocket envelope must stay below the provider's 64 KiB limit.
    if serde_json::to_vec(&result).map_err(|e| e.to_string())?.len() > 60 * 1024 {
        return Err("发音词典过大，编码后最多 60 KiB".into());
    }
    Ok(result)
}

static VOICE_CATALOG: tokio::sync::Mutex<Option<(std::time::Instant, Value)>> = tokio::sync::Mutex::const_new(None);

fn catalog_voices(catalog: &Value, model: &str, language: &str) -> Vec<Value> {
    let Some(voices) = catalog.as_array() else { return Vec::new(); };
    let mut voices: Vec<Value> = voices.iter().filter(|voice| {
        let lang = match voice["lang"].as_str().unwrap_or_default() { "eng" => "en", "spa" => "es", other => other };
        voice["modelId"].as_str() == Some(model) && lang == language && voice["speaker"].as_str().is_some_and(valid_speaker)
    }).map(|voice| json!({"speaker":voice["speaker"],"country":voice["country"],"description":voice["description"],"flagship":voice["flagship"]})).collect();
    voices.sort_by(|a,b| b["flagship"].as_bool().unwrap_or(false).cmp(&a["flagship"].as_bool().unwrap_or(false)).then_with(|| a["speaker"].as_str().cmp(&b["speaker"].as_str())));
    let mut seen = std::collections::HashSet::new();
    voices.retain(|voice| seen.insert(voice["speaker"].as_str().unwrap_or_default().to_owned()));
    voices
}

/// Rime's public catalog; no token is sent to the metadata endpoint.
#[tauri::command]
pub async fn rime_voices(model: String, language: String) -> Result<Value, String> {
    if !MODELS.contains(&model.as_str()) || !STT_LANGS.contains(&language.as_str()) { return Err("不支持的 Rime 对话模型或语言".into()); }
    let mut cache = VOICE_CATALOG.lock().await;
    if cache.as_ref().is_none_or(|(at, _)| at.elapsed().as_secs() >= 3600) {
        let response = client().get("https://users.rime.ai/data/voices/voice_details.json").timeout(std::time::Duration::from_secs(12)).send().await.map_err(|e| format!("读取 Rime 音色目录失败：{e}"))?.error_for_status().map_err(|e| format!("Rime 音色目录返回错误：{e}"))?;
        let catalog: Value = response.json().await.map_err(|e| format!("Rime 音色目录格式错误：{e}"))?;
        if !catalog.is_array() { return Err("Rime 音色目录应为数组".into()); }
        *cache = Some((std::time::Instant::now(), catalog));
    }
    Ok(json!({"voices":catalog_voices(&cache.as_ref().unwrap().1, &model, &language)}))
}

fn read_stored() -> Value {
    config_path()
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .map(|value| normalized(&value))
        .unwrap_or_else(|| normalized(&Value::Null))
}

fn config_for_ui(mut config: Value) -> Value {
    config["hasCredential"] = json!(auth_json().ok().and_then(|auth| bridge::stored_api_key(&auth, DEFAULT_PROVIDER_ID)).is_some());
    config["models"] = json!(MODELS);
    config["langs"] = json!(LANGS);
    config["sttLangs"] = json!(STT_LANGS);
    config
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
        "sttBackend": "rime",
        "ttsBackend": "rime",
        "spokenLang": pick("spokenLang").filter(|v| STT_LANGS.contains(v)).unwrap_or(stt_lang),
        "endpointMs": value.get("endpointMs").and_then(Value::as_u64).filter(|v| (200..=1200).contains(v)).unwrap_or(450),
        "timeScaleFactor": value.get("timeScaleFactor").and_then(Value::as_f64).filter(|v| v.is_finite() && (0.4..=2.5).contains(v)).unwrap_or(1.0),
        "textLookaheadTokens": value.get("textLookaheadTokens").and_then(Value::as_u64).filter(|v| *v <= 64).unwrap_or(0),
        "sttMode": pick("sttMode").filter(|v| ["written", "verbatim"].contains(v)).unwrap_or("written"),
        "contextTerms": context_terms(value.get("contextTerms").unwrap_or(&Value::Null)).unwrap_or_default(),
        "customLexicon": custom_lexicon(value.get("customLexicon").unwrap_or(&Value::Null)).unwrap_or_default(),
        "configured": source.is_some_and(|object| !object.is_empty()),
    })
}

/// 配置 + 一个「这把钥匙到底有没有」的结论，页面上要同时显示这两件事。
#[tauri::command]
pub async fn rime_config() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(config_for_ui(read_stored()))
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
        if key == "customLexicon" && !value.is_null() {
            out.insert(key.clone(), json!(custom_lexicon(value)?)); continue;
        }
        if key == "contextTerms" && !value.is_null() {
            out.insert(key.clone(), json!(context_terms(value)?)); continue;
        }
        if key == "timeScaleFactor" && !value.is_null() {
            let speed = value.as_f64().filter(|v| v.is_finite() && (0.4..=2.5).contains(v)).ok_or("语速时间系数需为 0.4–2.5")?;
            out.insert(key.clone(), json!(speed)); continue;
        }
        if key == "textLookaheadTokens" && !value.is_null() {
            let tokens = value.as_u64().filter(|v| *v <= 64).ok_or("前瞻文本需为 0–64 个 token")?;
            out.insert(key.clone(), json!(tokens)); continue;
        }
        if key == "endpointMs" && !value.is_null() {
            let ms = value.as_u64().filter(|v| (200..=1200).contains(v)).ok_or("断句静音时长需为 200–1200 毫秒")?;
            out.insert(key.clone(), json!(ms));
            continue;
        }
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
            "sttBackend" | "ttsBackend" if text != "rime" => return Err("语音对话只使用 Rime".into()),
            "spokenLang" if !STT_LANGS.contains(&text.as_str()) => return Err("Rime 语音对话目前只支持英语 en / 西班牙语 es".into()),
            "sttMode" if !["written", "verbatim"].contains(&text.as_str()) => return Err("未知的 Rime 转写模式".into()),
            "model" | "lang" | "sttLang" | "speaker" | "sttBackend" | "ttsBackend" | "spokenLang" | "sttMode" => {}
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
        let _guard = CONFIG_WRITE.lock().map_err(|_| "语音配置写入锁不可用")?;
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
        Ok(config_for_ui(normalized(&merged)))
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

/// 单段音频导出。实时对话和试听使用下方 WebSocket 流。
/// `format: "pcm"` 要裸 PCM16（`Accept: audio/L16`）而不是 mp3。
///
/// mp3 有两个额外成本：服务端要编码、客户端要解码，而播放器还得等**整段**文件才出声。
/// PCM 拿来就能进 Web Audio 的 buffer，几段之间还能排到同一条时间轴上——句子之间
/// 的缝就是这么消失的。
#[tauri::command]
pub async fn rime_tts(text: String, speaker: Option<String>, format: Option<String>) -> Result<Value, RimeError> {
    let text = text.trim().to_owned();
    if text.is_empty() {
        return Err(RimeError::new("invalid_input", "要合成的文本是空的"));
    }
    if text.chars().count() > MAX_TTS_CHARS {
        return Err(RimeError::new("invalid_input", "这句话太长，断句器应该先把它切开"));
    }
    let key = api_key().map_err(|message| RimeError::new("unauthenticated", message))?;
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
        "timeScaleFactor": config["timeScaleFactor"],
    });
    // Coda 的端点自己就是 coda；Mist v3 必须显式声明 modelId，否则会被默认值接走。
    if model == "mistv3" {
        body["modelId"] = json!("mistv3");
    } else if ["en", "de", "es", "fr", "it", "pt"].contains(&lang.as_str()) && config["customLexicon"].as_array().is_some_and(|entries| !entries.is_empty()) {
        body["customLexicon"] = config["customLexicon"].clone();
    }

    let pcm = format.as_deref() == Some("pcm");
    let response = client()
        .post(url)
        .header("Authorization", format!("Bearer {key}"))
        .header("Accept", if pcm { "audio/L16" } else { "audio/mpeg" })
        .timeout(std::time::Duration::from_secs(30))
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("连接 Rime 失败：{error}"))?;

    let status = response.status();
    if !status.is_success() {
        let request_id = response.headers().get("x-request-id").and_then(|value| value.to_str().ok()).map(str::to_owned);
        let detail = response.text().await.unwrap_or_default();
        return Err(RimeError::http("TTS", status.as_u16(), detail.trim(), request_id));
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
        "sampleRate": tts_sample_rate(&model),
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
async fn connect_ws(host: &str, path_and_query: &str, key: &str, subprotocol: Option<&str>) -> Result<SttSocket, RimeError> {
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
    let mut header = |name: &'static str, value: &str| -> Result<(), RimeError> {
        let parsed = tokio_tungstenite::tungstenite::http::HeaderValue::from_str(value)
            .map_err(|error| format!("请求头无效：{error}"))?;
        request.headers_mut().insert(name, parsed);
        Ok(())
    };
    header("Authorization", &format!("Bearer {key}"))?;
    if let Some(protocol) = subprotocol {
        header("Sec-WebSocket-Protocol", protocol)?;
    }

    let (socket, response) = tokio_tungstenite::client_async(request, tls)
        .await
        .map_err(|error| match error {
            tokio_tungstenite::tungstenite::Error::Http(response) => {
                let request_id = response.headers().get("x-request-id").and_then(|value| value.to_str().ok()).map(str::to_owned);
                let body = response.body().as_ref().map(|bytes| String::from_utf8_lossy(bytes).into_owned()).unwrap_or_default();
                RimeError::http(host, response.status().as_u16(), &body, request_id)
            }
            other => RimeError::new("transport", format!("{host} 升级失败：{other}")),
        })?;
    if let Some(protocol) = subprotocol {
        if response.headers().get("sec-websocket-protocol").and_then(|value| value.to_str().ok()) != Some(protocol) {
            return Err(RimeError::new("invalid_input", "Rime 未确认请求的 WebSocket 协议"));
        }
    }
    Ok(socket)
}

// WebSocket v1: one pooled connection, one independently cancellable context per reply.
enum TtsCommand {
    Warm { ready: tokio::sync::oneshot::Sender<Result<(), RimeError>> },
    Start { id: String, channel: tauri::ipc::Channel<Value> },
    Text { id: String, text: String },
    Finish { id: String },
    Cancel { id: String },
}
type TtsSender = tokio::sync::mpsc::Sender<TtsCommand>;
static TTS_STREAMS: std::sync::LazyLock<tokio::sync::Mutex<std::collections::HashMap<String, TtsSender>>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(std::collections::HashMap::new()));
static TTS_CONNECTIONS: std::sync::LazyLock<tokio::sync::Mutex<std::collections::HashMap<String, (String, TtsSender)>>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(std::collections::HashMap::new()));
fn tts_pool_key(config: &Value, key: &str) -> String {
    format!("{}:{}:{}:{}:{}:{}:{key}", config["model"], config["lang"], config["speaker"], config["timeScaleFactor"], config["textLookaheadTokens"], config["customLexicon"])
}

fn tts_start(config: &Value) -> Value {
    let mut start = json!({"speaker":config["speaker"],"language":config["lang"],"audioParameters":{"audioFormat":"audio/pcm","samplingRate":tts_sample_rate(config["model"].as_str().unwrap_or(DEFAULT_MODEL)),"timeScaleFactor":config["timeScaleFactor"]},"splitStrategy":"SPLIT_STRATEGY_ACCUMULATE_SENTENCE"});
    if config["model"] == "coda" {
        start["codaParameters"] = json!({"textLookaheadTokens":config["textLookaheadTokens"]});
        if ["en", "de", "es", "fr", "it", "pt"].contains(&config["lang"].as_str().unwrap_or_default()) && config["customLexicon"].as_array().is_some_and(|entries| !entries.is_empty()) {
            start["customLexicon"] = config["customLexicon"].clone();
        }
    }
    start
}

async fn run_tts_connection(pool_key: String, connection_id: String, key: String, config: Value, mut commands: tokio::sync::mpsc::Receiver<TtsCommand>) {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    let mut contexts: std::collections::HashMap<String, (tauri::ipc::Channel<Value>, tokio::time::Instant)> = std::collections::HashMap::new();
    let run = async {
        let host = if config["model"] == "mistv3" { "mist.api.rime.ai" } else { "coda.api.rime.ai" };
        let mut socket = tokio::time::timeout(std::time::Duration::from_secs(10), connect_ws(host, "/ws", &key, Some("rime.v1.json"))).await.map_err(|_| "TTS 连接超时".to_string())??;
        // ready is an engine signal, not proof of authentication; started/errors remain authoritative.
        let ready = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                match socket.next().await {
                    Some(Ok(Message::Text(text))) => {
                        let event: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
                        if event.pointer("/ready/protocol").and_then(Value::as_u64) == Some(1) { return Ok::<(), RimeError>(()); }
                        if let Some(error) = event.get("error") { return Err(RimeError::provider("TTS", error)); }
                    }
                    Some(Ok(Message::Ping(bytes))) => { socket.send(Message::Pong(bytes)).await.map_err(|e| e.to_string())?; }
                    Some(Ok(_)) => {}
                    _ => return Err("TTS 连接在 ready 前关闭".into()),
                }
            }
        }).await.map_err(|_| "TTS ready 超时".to_string())??;
        let _ = ready;
        let mut idle_since = tokio::time::Instant::now();
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(5));
        loop {
            tokio::select! {
                command = commands.recv() => {
                    let Some(command) = command else { return Ok(()); };
                    let (id, payload) = match command {
                        TtsCommand::Warm { ready } => { idle_since = tokio::time::Instant::now(); let _ = ready.send(Ok(())); continue; }
                        TtsCommand::Start { id, channel } => {
                            if contexts.len() >= 8 {
                                let _ = channel.send(RimeError::new("resource_exhausted", "朗读队列已满").event());
                                TTS_STREAMS.lock().await.remove(&id);
                                continue;
                            }
                            contexts.insert(id.clone(), (channel, tokio::time::Instant::now()));
                            let start = tts_start(&config);
                            (id, json!({"start":start}))
                        }
                        TtsCommand::Text { id, text } => {
                            if let Some((_, at)) = contexts.get_mut(&id) { *at = tokio::time::Instant::now(); } else { continue; }
                            (id, json!({"text":text}))
                        }
                        TtsCommand::Finish { id } => {
                            if !contexts.contains_key(&id) { continue; }
                            (id, json!({"end":{}}))
                        }
                        TtsCommand::Cancel { id } => {
                            if let Some((channel, _)) = contexts.remove(&id) { let _ = channel.send(json!({"done":true,"cancelled":true})); }
                            TTS_STREAMS.lock().await.remove(&id);
                            if contexts.is_empty() { idle_since = tokio::time::Instant::now(); }
                            (id, json!({"cancel":{}}))
                        }
                    };
                    let mut message = payload;
                    message["contextId"] = json!(id);
                    socket.send(Message::text(message.to_string())).await.map_err(|e| format!("TTS 发送失败：{e}"))?;
                }
                message = socket.next() => {
                    match message {
                        Some(Ok(Message::Text(text))) => {
                            let event: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
                            let id = event["contextId"].as_str().unwrap_or_default();
                            if let Some((channel, at)) = contexts.get_mut(id) {
                                *at = tokio::time::Instant::now();
                                if let Some(audio) = event["audio"].as_str() { let _ = channel.send(json!({"audio":audio,"contextId":id,"sampleRate":tts_sample_rate(config["model"].as_str().unwrap_or(DEFAULT_MODEL))})); }
                                if let Some(started) = event.get("started") { let _ = channel.send(json!({"contextId":id,"requestId":started["requestId"]})); }
                                if event.get("error").is_some() || event.get("done").is_some() || event.get("cancelled").is_some() {
                                    let _ = channel.send(if let Some(error) = event.get("error") { { let mut value = RimeError::provider("TTS", error).event(); value["contextId"] = json!(id); value } } else { json!({"done":true,"contextId":id}) });
                                    contexts.remove(id); TTS_STREAMS.lock().await.remove(id);
                                    if contexts.is_empty() { idle_since = tokio::time::Instant::now(); }
                                }
                            } else if event.get("error").is_some() && id.is_empty() {
                                return Err(RimeError::provider("TTS", &event["error"]));
                            }
                        }
                        Some(Ok(Message::Ping(bytes))) => { socket.send(Message::Pong(bytes)).await.map_err(|e| e.to_string())?; }
                        Some(Ok(Message::Close(frame))) => return Err(RimeError::new("transport", format!("Rime TTS 连接已关闭：{frame:?}"))),
                        None => return Err("TTS 连接已关闭".into()),
                        Some(Err(error)) => return Err(format!("TTS 连接错误：{error}").into()),
                        _ => {}
                    }
                }
                _ = tick.tick() => {
                    if contexts.is_empty() && idle_since.elapsed().as_secs() > 60 { let _ = socket.close(None).await; return Ok(()); }
                    if contexts.values().any(|(_, at)| at.elapsed().as_secs() > 45) { return Err("TTS 合成超时".into()); }
                }
            }
        }
    }.await;
    commands.close();
    {
        let mut pool = TTS_CONNECTIONS.lock().await;
        if pool.get(&pool_key).is_some_and(|(id, _)| id == &connection_id) { pool.remove(&pool_key); }
    }
    let error: RimeError = run.err().unwrap_or_else(|| "朗读连接已结束".into());
    for (id, (channel, _)) in contexts.drain() { let _ = channel.send(error.event()); TTS_STREAMS.lock().await.remove(&id); }
    while let Ok(command) = commands.try_recv() {
        match command {
            TtsCommand::Start { id, channel } => { let _ = channel.send(error.event()); TTS_STREAMS.lock().await.remove(&id); }
            TtsCommand::Warm { ready } => { let _ = ready.send(Err(error.clone())); }
            _ => {}
        }
    }
}

#[tauri::command]
pub async fn rime_tts_prepare() -> Result<(), RimeError> {
    let key = api_key().map_err(|message| RimeError::new("unauthenticated", message))?;
    let config = read_stored();
    let pool_key = tts_pool_key(&config, &key);
    let sender = {
        let mut pool = TTS_CONNECTIONS.lock().await;
        pool.retain(|_, (_, sender)| !sender.is_closed());
        if let Some((_, sender)) = pool.get(&pool_key) { sender.clone() } else {
            if pool.len() >= 4 { return Err(RimeError::new("resource_exhausted", "语音配置连接过多，请稍后再试")); }
            let (sender, receiver) = tokio::sync::mpsc::channel(128);
            let connection_id = uuid::Uuid::new_v4().to_string();
            pool.insert(pool_key.clone(), (connection_id.clone(), sender.clone()));
            tauri::async_runtime::spawn(run_tts_connection(pool_key.clone(), connection_id, key, config, receiver));
            sender
        }
    };
    let (ready, receiver) = tokio::sync::oneshot::channel();
    sender.send(TtsCommand::Warm { ready }).await.map_err(|_| "TTS 连接已中断".to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(12), receiver).await.map_err(|_| "TTS 预热超时".to_string())?.map_err(|_| "TTS 连接已关闭".to_string())?
}

#[tauri::command]
pub async fn rime_tts_stream(on_audio: tauri::ipc::Channel<Value>) -> Result<Value, RimeError> {
    let key = api_key().map_err(|message| RimeError::new("unauthenticated", message))?;
    let config = read_stored();
    let sample_rate = tts_sample_rate(config["model"].as_str().unwrap_or(DEFAULT_MODEL));
    // Credentials participate in connection identity so a changed key never reuses old auth.
    let pool_key = tts_pool_key(&config, &key);
    let sender = {
        let mut pool = TTS_CONNECTIONS.lock().await;
        pool.retain(|_, (_, sender)| !sender.is_closed());
        if let Some((_, sender)) = pool.get(&pool_key) { sender.clone() } else {
            if pool.len() >= 4 { return Err(RimeError::new("resource_exhausted", "语音配置连接过多，请稍后再试")); }
            let (sender, receiver) = tokio::sync::mpsc::channel(128);
            let connection_id = uuid::Uuid::new_v4().to_string();
            pool.insert(pool_key.clone(), (connection_id.clone(), sender.clone()));
            tauri::async_runtime::spawn(run_tts_connection(pool_key, connection_id, key, config, receiver));
            sender
        }
    };
    let id = uuid::Uuid::new_v4().to_string();
    TTS_STREAMS.lock().await.insert(id.clone(), sender.clone());
    if sender.send(TtsCommand::Start { id:id.clone(), channel:on_audio }).await.is_err() { TTS_STREAMS.lock().await.remove(&id); return Err("TTS 连接已中断".into()); }
    Ok(json!({"id":id,"sampleRate":sample_rate}))
}
#[tauri::command]
pub async fn rime_tts_send(id: String, text: String) -> Result<(), RimeError> {
    if text.len() > 32_000 { return Err(RimeError::new("invalid_input", "朗读分片过长")); }
    let sender = TTS_STREAMS.lock().await.get(&id).cloned().ok_or("朗读流已经结束")?;
    sender.send(TtsCommand::Text { id, text }).await.map_err(|_| "TTS 连接已中断".into())
}
#[tauri::command]
pub async fn rime_tts_finish(id: String) -> Result<(), RimeError> {
    let sender = TTS_STREAMS.lock().await.get(&id).cloned();
    if let Some(sender) = sender { sender.send(TtsCommand::Finish { id }).await.map_err(|_| "TTS 连接已中断".to_string())?; }
    Ok(())
}
#[tauri::command]
pub async fn rime_tts_cancel(id: String) -> Result<(), RimeError> {
    let sender = TTS_STREAMS.lock().await.remove(&id);
    if let Some(sender) = sender { let _ = sender.send(TtsCommand::Cancel { id }).await; }
    Ok(())
}

/// 打开 STT 连接。TLS 用 OpenSSL，和 relay 是同一套理由：系统根证书要显式加载，
/// 而且升级请求要带 `Authorization` 头——这是浏览器 WebSocket 做不到的那件事。
async fn connect_stt(key: &str) -> Result<SttSocket, RimeError> {
    tokio::time::timeout(std::time::Duration::from_secs(10), connect_ws(STT_HOST, STT_PATH, key, Some("rime.v1.json"))).await.map_err(|_| "STT 连接超时".to_string())?
}

/// A real start/started exchange checks service access; no audio or text is sent.
async fn probe_service(service: &str, key: &str, config: &Value) -> Result<Value, RimeError> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    let began = tokio::time::Instant::now();
    let stt = service == "STT";
    let host = if stt { STT_HOST } else if config["model"] == "mistv3" { "mist.api.rime.ai" } else { "coda.api.rime.ai" };
    let mut socket = connect_ws(host, "/ws", key, Some("rime.v1.json")).await?;
    let outcome = async {
        if stt {
            let started = send_start(&mut socket, config["sttLang"].as_str().unwrap_or("en"), config).await?;
            let _ = socket.send(Message::text(json!({"cancel":{}}).to_string())).await;
            return Ok(json!({"ok":true,"latencyMs":began.elapsed().as_millis(),"requestId":started["requestId"]}));
        }
        loop {
            match socket.next().await {
                Some(Ok(Message::Text(text))) => {
                    let event: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
                    if let Some(error) = event.get("error") { return Err(RimeError::provider(service, error)); }
                    if !stt && event.pointer("/ready/protocol").and_then(Value::as_u64) == Some(1) {
                        socket.send(Message::text(json!({"contextId":"diagnostic","start":tts_start(config)}).to_string())).await.map_err(|e| e.to_string())?;
                    }
                    if let Some(started) = event.get("started") {
                        let cancel = if stt { json!({"cancel":{}}) } else { json!({"contextId":"diagnostic","cancel":{}}) };
                        let _ = socket.send(Message::text(cancel.to_string())).await;
                        return Ok(json!({"ok":true,"latencyMs":began.elapsed().as_millis(),"requestId":started["requestId"]}));
                    }
                }
                Some(Ok(Message::Ping(bytes))) => { socket.send(Message::Pong(bytes)).await.map_err(|e| e.to_string())?; }
                Some(Ok(Message::Close(frame))) => return Err(RimeError::new("transport", format!("Rime {service} 检查时关闭连接：{frame:?}"))),
                Some(Err(error)) => return Err(RimeError::new("transport", format!("Rime {service} 检查失败：{error}"))),
                None => return Err(RimeError::new("transport", format!("Rime {service} 未确认请求便关闭了连接"))),
                _ => {}
            }
        }
    }.await;
    let _ = socket.close(None).await;
    outcome
}

#[tauri::command]
pub async fn rime_check() -> Result<Value, RimeError> {
    let key = api_key().map_err(|message| RimeError::new("unauthenticated", message))?;
    let config = read_stored();
    let check = |service| {
        let key = &key; let config = &config;
        async move {
            match tokio::time::timeout(std::time::Duration::from_secs(12), probe_service(service, key, config)).await {
                Ok(Ok(report)) => report,
                Ok(Err(error)) => json!({"ok":false,"error":error}),
                Err(_) => json!({"ok":false,"error":RimeError::new("timeout", format!("Rime {service} 连接检查超时"))}),
            }
        }
    };
    let (stt, tts) = tokio::join!(check("STT"), check("TTS"));
    Ok(json!({"stt":stt,"tts":tts}))
}

/// 把一整句录音转成文字（一次性）。
///
/// 这是**兜底**路径：语音页正常走流式（`rime_stt_open/push/finish`），因为
/// 等静音结束再上传、再等握手，光这一段就要多花半秒以上。这里留着是为了
/// 流式打不开时还能用。
#[tauri::command]
pub async fn rime_stt(audio_base64: String) -> Result<Value, RimeError> {
    use futures_util::SinkExt;
    use tokio_tungstenite::tungstenite::Message;

    let audio = base64::engine::general_purpose::STANDARD
        .decode(audio_base64.trim())
        .map_err(|error| format!("音频不是合法 base64：{error}"))?;
    if audio.is_empty() {
        return Err(RimeError::new("invalid_input", "录音是空的"));
    }
    if audio.len() > MAX_STT_BYTES {
        return Err(RimeError::new("invalid_input", "这段录音太长"));
    }
    if audio.len() % 2 != 0 {
        return Err(RimeError::new("invalid_input", "PCM16 的字节数必须是偶数"));
    }

    let key = api_key().map_err(|message| RimeError::new("unauthenticated", message))?;
    let language = stt_language();
    let mut socket = connect_stt(&key).await?;
    send_start(&mut socket, &language, &read_stored()).await?;
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

async fn send_start(socket: &mut SttSocket, language: &str, config: &Value) -> Result<Value, RimeError> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    let start = stt_start(language, config);
    socket
        .send(Message::text(start.to_string()))
        .await
        .map_err(|error| RimeError::new("transport", format!("发送 start 失败：{error}")))?;
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            match socket.next().await {
                Some(Ok(Message::Text(text))) => {
                    let event: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
                    if let Some(error) = event.get("error") { return Err(RimeError::provider("STT", error)); }
                    if let Some(started) = event.get("started") { return Ok(started.clone()); }
                }
                Some(Ok(Message::Ping(bytes))) => { socket.send(Message::Pong(bytes)).await.map_err(|e| e.to_string())?; }
                Some(Ok(Message::Close(frame))) => return Err(RimeError::new("transport", format!("Rime STT 在确认请求前关闭：{frame:?}"))),
                Some(Err(error)) => return Err(RimeError::new("transport", format!("Rime STT 连接错误：{error}"))),
                None => return Err("Rime STT 在确认请求前断开".into()),
                _ => {}
            }
        }
    }).await.map_err(|_| RimeError::new("timeout", "Rime STT 未及时确认识别请求"))?
}

fn stt_start(language: &str, config: &Value) -> Value {
    json!({
        "start": {
            "outputContract": "STREAMING_OUTPUT_CONTRACT_REVISED_HYPOTHESES",
            "language": language,
            "mode": if config["sttMode"] == "verbatim" { "TRANSCRIPTION_MODE_VERBATIM" } else { "TRANSCRIPTION_MODE_WRITTEN" },
            "contextTerms": config["contextTerms"],
        }
    })
}

async fn send_audio(socket: &mut SttSocket, audio: &[u8]) -> Result<(), RimeError> {
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
async fn read_done(socket: &mut SttSocket, language: &str) -> Result<String, RimeError> {
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
            Ok(Some(Err(error))) => return Err(format!("Rime STT 连接出错：{error}").into()),
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
            return Err(RimeError::provider("STT", error));
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
    result: tokio::sync::oneshot::Receiver<Result<String, RimeError>>,
}

static STREAMS: std::sync::LazyLock<tokio::sync::Mutex<std::collections::HashMap<String, SttStream>>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(std::collections::HashMap::new()));

async fn run_stream(
    key: String,
    language: String,
    config: Value,
    mut commands: tokio::sync::mpsc::Receiver<SttCommand>,
    result: tokio::sync::oneshot::Sender<Result<String, RimeError>>,
    on_event: Option<tauri::ipc::Channel<Value>>,
) {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    let publish = |event: Value| { if let Some(channel) = &on_event { let _ = channel.send(event); } };
    let outcome = async {
        let mut socket = connect_stt(&key).await?;
        let started = send_start(&mut socket, &language, &config).await?;
        publish(json!({"started":true,"requestId":started["requestId"]}));
        let deadline = tokio::time::sleep(std::time::Duration::from_secs(115));
        tokio::pin!(deadline);
        let mut bytes_sent = 0usize;
        loop {
            tokio::select! {
                command = commands.recv() => {
                    match command {
                        Some(SttCommand::Audio(audio)) => {
                            bytes_sent += audio.len();
                            if bytes_sent > MAX_STT_BYTES { return Err(RimeError::new("invalid_input", "这段录音太长")); }
                            send_audio(&mut socket, &audio).await?;
                        }
                        Some(SttCommand::End) => { socket.send(Message::text(json!({"end":{}}).to_string())).await.map_err(|e| e.to_string())?; }
                        Some(SttCommand::Cancel) | None => { let _ = socket.send(Message::text(json!({"cancel":{}}).to_string())).await; return Err("Rime STT 被取消".into()); }
                    }
                }
                message = socket.next() => {
                    match message {
                        Some(Ok(Message::Text(text))) => {
                            let event: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
                            if let Some(done) = event.get("done") { return Ok(done["text"].as_str().unwrap_or_default().trim().to_owned()); }
                            if let Some(error) = event.get("error") { return Err(RimeError::provider("STT", error)); }
                            if event.get("cancelled").is_some() { return Err("Rime STT 被取消".into()); }
                            if event.get("started").is_some() { publish(json!({"started":true})); }
                            if let Some(hypothesis) = event.get("hypothesis") { publish(json!({"partial":hypothesis["text"].as_str().unwrap_or_default()})); }
                        }
                        Some(Ok(Message::Ping(bytes))) => { socket.send(Message::Pong(bytes)).await.map_err(|e| e.to_string())?; }
                        Some(Ok(Message::Close(_))) | None => return Err("STT 提前断开，没有最终转写".into()),
                        Some(Err(error)) => return Err(format!("STT 连接出错：{error}").into()),
                        _ => {}
                    }
                }
                _ = &mut deadline => return Err("STT 已达到单句时长限制".into()),
            }
        }
    }.await;
    match &outcome { Ok(text) => publish(json!({"done":true,"text":text})), Err(error) => publish(error.event()) }
    let _ = result.send(outcome);
}

/// 开一条流。返回时**还没有**连上——握手在后台做，前端可以在用户说话时就开始推音频。
#[tauri::command]
pub async fn rime_stt_open(on_event: tauri::ipc::Channel<Value>) -> Result<Value, RimeError> {
    let key = api_key().map_err(|message| RimeError::new("unauthenticated", message))?;
    let language = stt_language();
    let id = uuid::Uuid::new_v4().to_string();
    let (command_tx, command_rx) = tokio::sync::mpsc::channel(256);
    let (result_tx, result_rx) = tokio::sync::oneshot::channel();
    tauri::async_runtime::spawn(run_stream(key, language.clone(), read_stored(), command_rx, result_tx, Some(on_event)));
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
pub async fn rime_stt_push(id: String, audio_base64: String) -> Result<(), RimeError> {
    let audio = base64::engine::general_purpose::STANDARD
        .decode(audio_base64.trim())
        .map_err(|error| format!("音频不是合法 base64：{error}"))?;
    if audio.is_empty() {
        return Ok(());
    }
    if audio.len() > 64 * 1024 || audio.len() % 2 != 0 { return Err(RimeError::new("invalid_input", "STT 音频分片必须是至多 64KiB 的 PCM16")); }
    let sender = STREAMS.lock().await.get(&id).map(|stream| stream.commands.clone()).ok_or("这条流已经结束了")?;
    sender.send(SttCommand::Audio(audio))
        .await
        .map_err(|_| RimeError::new("transport", "Rime STT 流已经中断"))
}

#[tauri::command]
pub async fn rime_stt_finish(id: String) -> Result<Value, RimeError> {
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
pub async fn rime_stt_abort(id: String) -> Result<(), RimeError> {
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

    #[tokio::test]
    #[ignore = "requires a configured Rime Token and live network access"]
    async fn live_services_accept_saved_configuration() {
        let report = rime_check().await.expect("Rime live diagnostic must complete");
        println!("{report}");
        assert_eq!(report["stt"]["ok"], true, "STT rejected the saved configuration");
        assert_eq!(report["tts"]["ok"], true, "TTS rejected the saved configuration");
    }

    #[tokio::test]
    #[ignore = "synthesizes two short samples and transcribes generated audio with the saved Rime Token"]
    async fn live_streaming_synthesis_reuses_connection_and_roundtrips_through_recognition() {
        let mut captured = Vec::new();
        let mut sample_rate = 0;
        for turn in 0..2 {
            let (events, mut receiver) = tokio::sync::mpsc::unbounded_channel::<Value>();
            let channel = tauri::ipc::Channel::new(move |body| {
                if let tauri::ipc::InvokeResponseBody::Json(text) = body {
                    let _ = events.send(serde_json::from_str(&text).expect("JSON channel event"));
                }
                Ok(())
            });
            let began = tokio::time::Instant::now();
            let stream = rime_tts_stream(channel).await.expect("open TTS");
            let id = stream["id"].as_str().unwrap().to_owned();
            sample_rate = stream["sampleRate"].as_u64().unwrap() as usize;
            rime_tts_send(id.clone(), "Orbit is ".into()).await.unwrap();
            rime_tts_send(id.clone(), "ready to help.".into()).await.unwrap();
            rime_tts_finish(id.clone()).await.unwrap();
            let mut audio = Vec::new();
            let mut first_audio = None;
            tokio::time::timeout(std::time::Duration::from_secs(25), async {
                loop {
                    let event = receiver.recv().await.expect("TTS terminal event");
                    assert!(event.get("error").is_none(), "{event}");
                    if let Some(chunk) = event["audio"].as_str() {
                        first_audio.get_or_insert_with(|| began.elapsed().as_millis());
                        audio.extend(base64::engine::general_purpose::STANDARD.decode(chunk).unwrap());
                    }
                    if event["done"] == true { break; }
                }
            }).await.expect("TTS round must complete");
            assert!(!audio.is_empty());
            assert!(!TTS_STREAMS.lock().await.contains_key(&id));
            println!("TTS turn {}: first audio {:?}ms, {} bytes, {}Hz", turn + 1, first_audio, audio.len(), sample_rate);
            captured = audio;
        }
        let samples: Vec<i16> = captured.chunks_exact(2).map(|sample| i16::from_le_bytes([sample[0],sample[1]])).collect();
        let pcm: Vec<u8> = (0..samples.len() * 16000 / sample_rate).flat_map(|index| {
            samples[index * sample_rate / 16000].to_le_bytes()
        }).collect();
        let stream = rime_stt_open(tauri::ipc::Channel::new(|_| Ok(()))).await.expect("open STT");
        let id = stream["id"].as_str().unwrap().to_owned();
        for chunk in pcm.chunks(STT_CHUNK_BYTES) {
            rime_stt_push(id.clone(), base64::engine::general_purpose::STANDARD.encode(chunk)).await.unwrap();
        }
        let result = rime_stt_finish(id.clone()).await.expect("transcribe synthetic speech");
        assert!(!result["text"].as_str().unwrap_or_default().is_empty());
        assert!(!STREAMS.lock().await.contains_key(&id));
        println!("STT generated speech: {}", result["text"]);
    }

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
    fn legacy_external_backends_cannot_be_reactivated() {
        let config = normalized(&json!({"sttBackend":"speech","ttsBackend":"system","spokenLang":"zh"}));
        assert_eq!(config["sttBackend"], "rime");
        assert_eq!(config["ttsBackend"], "rime");
        assert_eq!(config["spokenLang"], "en");
        assert!(validate_patch(&json!({"sttBackend":"speech"})).is_err());
        assert!(validate_patch(&json!({"ttsBackend":"system"})).is_err());
        assert!(validate_patch(&json!({"spokenLang":"zh"})).is_err());
    }

    #[test]
    fn context_terms_follow_rimes_byte_limit_and_control_marker_rules() {
        assert_eq!(context_terms(&json!(["Orbit", " TypeSafe "])).unwrap(), vec!["Orbit", "TypeSafe"]);
        assert!(context_terms(&json!([" "])).is_err());
        assert!(context_terms(&json!(["<|instruction|>"])).is_err());
        assert!(context_terms(&json!(["汉".repeat(342)])).is_err());
        assert!(context_terms(&json!(["a".repeat(512), "b".repeat(512)])).is_err());
    }

    #[test]
    fn streaming_requests_apply_settings_to_the_right_protocol_fields() {
        let config = normalized(&json!({"timeScaleFactor":0.85,"textLookaheadTokens":8,"sttMode":"verbatim","contextTerms":["Orbit"]}));
        let tts = tts_start(&config);
        assert_eq!(tts.pointer("/audioParameters/timeScaleFactor"), Some(&json!(0.85)));
        assert_eq!(tts.pointer("/audioParameters/samplingRate"), Some(&json!(24000)));
        assert_eq!(tts.pointer("/codaParameters/textLookaheadTokens"), Some(&json!(8)));
        let mut mist = config.clone(); mist["model"] = json!("mistv3");
        let tts = tts_start(&mist);
        assert_eq!(tts.pointer("/audioParameters/samplingRate"), Some(&json!(22050)));
        assert!(tts.get("codaParameters").is_none());
        let stt = stt_start("en", &config);
        assert_eq!(stt.pointer("/start/mode"), Some(&json!("TRANSCRIPTION_MODE_VERBATIM")));
        assert_eq!(stt.pointer("/start/contextTerms"), Some(&json!(["Orbit"])));
        assert_ne!(tts_pool_key(&config, "key"), tts_pool_key(&mist, "key"));
        assert!(validate_patch(&json!({"timeScaleFactor":0.1})).is_err());
    }

    #[test]
    fn voice_catalog_excludes_retired_models_and_incompatible_languages() {
        let catalog = json!([
            {"speaker":"english","modelId":"coda","lang":"eng","flagship":true},
            {"speaker":"spanish","modelId":"coda","lang":"spa"},
            {"speaker":"retired","modelId":"mistv2","lang":"eng"},
            {"speaker":"fast","modelId":"mistv3","lang":"eng"}
        ]);
        let result = catalog_voices(&catalog, "coda", "en");
        assert_eq!(result.len(), 1);
        assert_eq!(result[0]["speaker"], "english");
        assert_eq!(catalog_voices(&catalog, "coda", "es")[0]["speaker"], "spanish");
    }

    #[test]
    fn pronunciation_dictionary_is_validated_and_only_sent_to_supported_coda_languages() {
        let lexicon = json!([{"spelling":"Aoife","pronunciation":"\" i . f @"}]);
        let config = normalized(&json!({"customLexicon":lexicon}));
        assert_eq!(tts_start(&config)["customLexicon"], lexicon);
        let mut mist = config.clone(); mist["model"] = json!("mistv3");
        assert!(tts_start(&mist).get("customLexicon").is_none());
        let mut japanese = config.clone(); japanese["lang"] = json!("ja");
        assert!(tts_start(&japanese).get("customLexicon").is_none());
        let other = normalized(&json!({"customLexicon":[{"spelling":"other","pronunciation":"\" i"}]}));
        assert_ne!(tts_pool_key(&config, "key"), tts_pool_key(&other, "key"));
        assert!(custom_lexicon(&json!([{"spelling":"word","pronunciation":"音标"}])).is_err());
        assert!(custom_lexicon(&json!([{"spelling":"word","pronunciation":" "}])).is_err());
        assert!(custom_lexicon(&json!([{"spelling":"Word","pronunciation":"w"},{"spelling":"word","pronunciation":"w"}])).is_err());
        assert!(custom_lexicon(&json!([{"spelling":"word","pronunciation":"a".repeat(62000)}])).is_err());
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
