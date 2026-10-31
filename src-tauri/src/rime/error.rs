use serde::Serialize;
use serde_json::Value;

/// Preserve the provider's error class across IPC; callers must not retry bad credentials.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RimeError {
    pub kind: String,
    pub message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
}

impl RimeError {
    pub fn new(kind: &str, message: impl Into<String>) -> Self {
        Self {
            kind: kind.into(), message: message.into(), request_id: None, http_status: None,
            retryable: matches!(kind, "transport" | "unavailable" | "timeout" | "internal"),
        }
    }

    pub fn provider(service: &str, value: &Value) -> Self {
        let kind = value["kind"].as_str().unwrap_or("unknown");
        let detail = value["message"].as_str().unwrap_or("服务没有说明原因");
        let explanation = match kind {
            "unauthenticated" => "鉴权失败，请检查 Rime Token 和所属账号；此错误不能证明余额不足",
            "permission_denied" => "当前 Token 没有使用此服务的权限",
            "resource_exhausted" => "当前连接或并发数量达到限制，请稍后重试",
            "invalid_input" => "请求参数被拒绝，请检查模型、语言、音色和发音词典",
            _ => "服务请求失败",
        };
        let mut error = Self::new(kind, format!("Rime {service}：{explanation}。{}", super::truncate(detail)));
        error.request_id = value["requestId"].as_str().map(str::to_owned);
        error
    }

    pub fn http(service: &str, status: u16, body: &str, request_id: Option<String>) -> Self {
        let value = serde_json::from_str::<Value>(body).ok();
        let mut error = if let Some(detail) = value.as_ref().and_then(|value| value.get("error")).filter(|value| value.is_object()) {
            Self::provider(service, detail)
        } else {
            let (kind, explanation) = match status {
                401 => ("unauthenticated", "鉴权或账号状态检查失败，请核对 Rime Token 和所属账号；此状态不能证明余额不足"),
                402 => ("billing", "Rime 返回计费错误，请检查该 Token 所属账号的计费状态"),
                403 => ("permission_denied", "当前 Token 无权访问此服务"),
                429 => ("resource_exhausted", "连接或请求数量达到限制，请稍后重试"),
                500..=599 => ("unavailable", "Rime 服务暂时不可用"),
                _ => ("invalid_input", "请求被拒绝"),
            };
            Self::new(kind, format!("Rime {service} HTTP {status}：{explanation}。{}", super::truncate(body)))
        };
        error.http_status = Some(status);
        error.request_id = error.request_id.or(request_id);
        error
    }

    pub fn event(&self) -> Value {
        let mut value = serde_json::to_value(self).expect("RimeError is serializable");
        value["error"] = Value::String(self.message.clone());
        value
    }
}

impl From<String> for RimeError {
    fn from(message: String) -> Self { Self::new("transport", message) }
}
impl From<&str> for RimeError {
    fn from(message: &str) -> Self { Self::from(message.to_owned()) }
}
impl std::fmt::Display for RimeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { formatter.write_str(&self.message) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn authentication_is_not_reported_as_a_balance_fact_or_retried() {
        let error = RimeError::http("STT", 401, "", Some("request-1".into()));
        assert!(!error.retryable);
        assert_eq!(error.kind, "unauthenticated");
        assert_eq!(error.request_id.as_deref(), Some("request-1"));
        assert!(error.message.contains("不能证明余额不足"));
        assert!(!RimeError::http("TTS", 429, "limit", None).retryable);
        assert!(RimeError::http("TTS", 503, "busy", None).retryable);
    }

    #[test]
    fn provider_identity_survives_the_ipc_error_event() {
        let event = RimeError::provider("TTS", &json!({"kind":"invalid_input","message":"unknown voice","requestId":"req"})).event();
        assert_eq!(event["kind"], "invalid_input");
        assert_eq!(event["requestId"], "req");
        assert_eq!(event["retryable"], false);
        assert!(event["error"].as_str().unwrap().contains("unknown voice"));
    }
}
