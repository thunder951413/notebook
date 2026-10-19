//! OpenAI-compatible chat completion proxy. The API key never reaches the
//! web view: it is read from the keychain here and sent only to the
//! provider's own host.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::secrets::Secrets;
use crate::webdav::sha256_hex;

const MAX_MESSAGES: usize = 40;
const MAX_CONTENT_CHARACTERS: usize = 320_000;
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
pub struct Message {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub request_id: String,
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub messages: Vec<Message>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completion_tokens: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct ChatResponse {
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub usage: Usage,
}

pub fn validated_base_url(provider: &str, value: &str) -> Result<url::Url, String> {
    let base = url::Url::parse(value.trim()).map_err(|_| "AI 服务地址不正确".to_string())?;
    if base.scheme() != "https" {
        return Err("AI 服务地址必须使用 HTTPS".into());
    }
    if !base.username().is_empty() || base.password().is_some() {
        return Err("AI 服务地址不能包含用户名或密码".into());
    }
    if base.query().is_some() || base.fragment().is_some() {
        return Err("AI 服务地址不能包含查询参数或锚点".into());
    }
    let host = base.host_str().unwrap_or("");
    let default_port = base.port().is_none_or(|port| port == 443);
    if provider == "openai" && (host != "api.openai.com" || !default_port) {
        return Err("OpenAI Key 只能发送到 api.openai.com；代理服务请选择“OpenAI 兼容服务”".into());
    }
    if provider == "deepseek" && (host != "api.deepseek.com" || !default_port) {
        return Err("DeepSeek Key 只能发送到 api.deepseek.com；代理服务请选择“OpenAI 兼容服务”".into());
    }
    Ok(base)
}

pub fn credential_key(provider: &str, base_url: &str) -> Result<String, String> {
    if !matches!(provider, "openai" | "deepseek" | "custom") {
        return Err("AI 服务商无效".into());
    }
    let base = validated_base_url(provider, base_url)?;
    if provider != "custom" {
        return Ok(format!("ai-provider-key:{provider}"));
    }
    let normalized = base.as_str().trim_end_matches('/').to_string();
    Ok(format!("ai-provider-key:custom:{}", sha256_hex(normalized.as_bytes())))
}

fn network_failure(error: &reqwest::Error) -> String {
    let detail = crate::webdav::reqwest_error_text(error).to_lowercase();
    let reason = if error.is_timeout() {
        "建立连接超时"
    } else if detail.contains("dns") || detail.contains("lookup") || detail.contains("resolve") {
        "无法解析服务域名"
    } else if detail.contains("refused") {
        "服务拒绝连接"
    } else if detail.contains("reset") {
        "连接被服务端或代理重置"
    } else if detail.contains("certificate") || detail.contains("tls") || detail.contains("ssl") {
        "无法验证服务的 TLS 证书"
    } else {
        "无法建立网络连接"
    };
    format!("{reason}。请检查服务地址、网络、代理和证书后重试。")
}

pub async fn complete(http: &reqwest::Client, secrets: &Secrets, request: ChatRequest) -> Result<ChatResponse, String> {
    if request.request_id.is_empty() || request.request_id.len() > 100 {
        return Err("AI 请求标识无效".into());
    }
    let key_name = credential_key(&request.provider, &request.base_url)?;
    let base = validated_base_url(&request.provider, &request.base_url)?;
    let model = request.model.trim().to_string();
    if model.is_empty() || request.model.len() > 200 {
        return Err("AI 模型名称无效".into());
    }
    if request.messages.is_empty() || request.messages.len() > MAX_MESSAGES {
        return Err("AI 对话消息数量无效".into());
    }
    if request.messages.iter().any(|m| !matches!(m.role.as_str(), "system" | "user" | "assistant")) {
        return Err("AI 对话消息格式无效".into());
    }
    let total: usize = request.messages.iter().map(|m| m.content.encode_utf16().count()).sum();
    if total > MAX_CONTENT_CHARACTERS {
        return Err("AI 上下文超过 320,000 字符限制".into());
    }
    let key = {
        let secrets_key = key_name.clone();
        let value = secrets.get(&secrets_key)?;
        value.ok_or_else(|| "尚未在 Notebook 设置中保存 AI API Key".to_string())?
    };
    let mut base_text = base.as_str().to_string();
    if !base_text.ends_with('/') {
        base_text.push('/');
    }
    let endpoint = url::Url::parse(&base_text).and_then(|b| b.join("chat/completions")).map_err(|e| e.to_string())?;
    let body = json!({
        "model": model,
        "messages": request.messages.iter().map(|m| json!({ "role": m.role, "content": m.content })).collect::<Vec<_>>(),
        "stream": false,
    });
    let mut response = http
        .post(endpoint)
        .bearer_auth(key)
        .json(&body)
        .send()
        .await
        .map_err(|error| if error.is_timeout() { "AI 服务响应超时".to_string() } else { network_failure(&error) })?;
    let status = response.status();
    if response.content_length().is_some_and(|length| length as usize > MAX_RESPONSE_BYTES) {
        return Err("AI 服务响应超过 4 MB 限制".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| if error.is_timeout() { "AI 服务响应超时".to_string() } else { network_failure(&error) })? {
        bytes.extend_from_slice(&chunk);
        if bytes.len() > MAX_RESPONSE_BYTES {
            return Err("AI 服务响应超过 4 MB 限制".into());
        }
    }
    let payload: Option<Value> = serde_json::from_slice(&bytes).ok();
    if !status.is_success() {
        let message = payload
            .as_ref()
            .and_then(|p| p.pointer("/error/message"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("AI 服务返回 {}", status.as_u16()));
        return Err(message.chars().take(1000).collect());
    }
    let payload = payload.unwrap_or(Value::Null);
    let content = payload.pointer("/choices/0/message/content").and_then(Value::as_str).filter(|c| !c.is_empty()).ok_or("AI 服务没有返回正文")?;
    Ok(ChatResponse {
        content: content.to_string(),
        model: payload.get("model").and_then(Value::as_str).map(str::to_string),
        usage: Usage {
            prompt_tokens: payload.pointer("/usage/prompt_tokens").and_then(Value::as_u64),
            completion_tokens: payload.pointer("/usage/completion_tokens").and_then(Value::as_u64),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_urls_that_could_leak_a_key() {
        for bad in ["http://api.openai.com/v1", "https://user:pw@example.com/v1", "https://example.com/v1?key=1", "https://example.com/v1#frag", "not a url"] {
            assert!(validated_base_url("custom", bad).is_err(), "{bad} must be rejected");
        }
    }

    #[test]
    fn built_in_providers_only_reach_their_own_host() {
        assert!(validated_base_url("openai", "https://api.openai.com/v1").is_ok());
        assert!(validated_base_url("openai", "https://evil.example/v1").is_err());
        assert!(validated_base_url("openai", "https://api.openai.com:8443/v1").is_err());
        assert!(validated_base_url("deepseek", "https://api.deepseek.com").is_ok());
        assert!(validated_base_url("deepseek", "https://api.openai.com").is_err());
        assert!(validated_base_url("custom", "https://proxy.example.com/v1").is_ok());
    }

    #[test]
    fn credential_keys_are_scoped_per_provider_and_custom_endpoint() {
        assert_eq!(credential_key("openai", "https://api.openai.com/v1").unwrap(), "ai-provider-key:openai");
        assert!(credential_key("unknown", "https://example.com").is_err());
        let first = credential_key("custom", "https://a.example.com/v1").unwrap();
        let second = credential_key("custom", "https://b.example.com/v1").unwrap();
        assert_ne!(first, second);
        assert_eq!(first, credential_key("custom", "https://a.example.com/v1/").unwrap());
    }
}
