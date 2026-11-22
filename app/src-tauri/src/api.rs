//! HTTP client for the AM Backup Worker API.

use futures_util::Future;
use reqwest::{header, Client, Method, RequestBuilder, Response, StatusCode};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::io::SeekFrom;
use std::path::Path;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use crate::model::{Policy, UserInfo};

/// Largest body sent in one request; Workers accept up to 100 MB.
pub const SINGLE_UPLOAD_MAX: u64 = 48 * 1024 * 1024;
/// R2 multipart part size (all parts except the last must be equal).
pub const PART_SIZE: u64 = 32 * 1024 * 1024;

#[derive(Debug, Clone)]
pub enum ApiError {
    /// The session is missing, expired or was revoked.
    Unauthorized(String),
    Server { status: u16, code: String, message: String },
    Network(String),
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ApiError::Unauthorized(m) => write!(f, "{m}"),
            ApiError::Server { message, .. } => write!(f, "{message}"),
            ApiError::Network(m) => write!(f, "{m}"),
        }
    }
}

impl std::error::Error for ApiError {}

impl ApiError {
    pub fn code(&self) -> &str {
        match self {
            ApiError::Unauthorized(_) => "unauthorized",
            ApiError::Server { code, .. } => code,
            ApiError::Network(_) => "network",
        }
    }
    fn retryable(&self) -> bool {
        match self {
            ApiError::Network(_) => true,
            ApiError::Server { status, .. } => *status >= 500 || *status == 429,
            ApiError::Unauthorized(_) => false,
        }
    }
}

fn network_error(e: reqwest::Error) -> ApiError {
    let msg = if e.is_connect() {
        "Can't reach the backup server. Check the internet connection and server address.".to_string()
    } else if e.is_timeout() {
        "The backup server took too long to respond.".to_string()
    } else if e.is_decode() {
        "The server sent a response this app could not read. Is the server address correct?".to_string()
    } else {
        format!("Network problem: {e}")
    };
    ApiError::Network(msg)
}

/// Percent-encodes one URL path segment.
pub fn encode_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[derive(Clone)]
pub struct Api {
    client: Client,
    base: String,
    token: Option<String>,
    device: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub ok: bool,
    pub service: Option<String>,
    pub version: Option<String>,
    pub build: Option<String>,
    pub environment: Option<String>,
    pub needs_setup: bool,
    pub setup_key_configured: Option<bool>,
    pub server_time: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginResponse {
    pub token: String,
    pub user: UserInfo,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeResponse {
    pub user: UserInfo,
    pub policy: Policy,
}

#[derive(Debug, Deserialize)]
pub struct IdResponse {
    pub id: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadStart {
    upload_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadedPart {
    part_number: u32,
    etag: String,
}

pub fn normalize_base(url: &str) -> String {
    let mut u = url.trim().trim_end_matches('/').to_string();
    if !u.starts_with("http://") && !u.starts_with("https://") {
        let local = u.starts_with("localhost") || u.starts_with("127.0.0.1");
        u = format!("{}{}", if local { "http://" } else { "https://" }, u);
    }
    u
}

impl Api {
    pub fn new(base: &str, token: Option<String>, device: &str) -> Self {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(20))
            .read_timeout(Duration::from_secs(180))
            .pool_idle_timeout(Duration::from_secs(60))
            .user_agent(concat!("AMBackup/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("HTTP client");
        Self { client, base: normalize_base(base), token, device: device.to_string() }
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    pub fn has_token(&self) -> bool {
        self.token.is_some()
    }

    fn req(&self, method: Method, path: &str) -> RequestBuilder {
        let mut rb = self.client.request(method, format!("{}{}", self.base, path)).header("x-device", &self.device);
        if let Some(t) = &self.token {
            rb = rb.bearer_auth(t);
        }
        rb
    }

    async fn send(&self, rb: RequestBuilder) -> Result<Response, ApiError> {
        let res = rb.send().await.map_err(network_error)?;
        if res.status().is_success() {
            return Ok(res);
        }
        let status = res.status();
        let body: serde_json::Value = res.json().await.unwrap_or_default();
        let message = body
            .get("error")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| format!("The server answered {status}."));
        let code = body.get("code").and_then(|v| v.as_str()).unwrap_or("error").to_string();
        if status == StatusCode::UNAUTHORIZED {
            Err(ApiError::Unauthorized(message))
        } else {
            Err(ApiError::Server { status: status.as_u16(), code, message })
        }
    }

    async fn json<T: DeserializeOwned>(&self, rb: RequestBuilder) -> Result<T, ApiError> {
        let res = self.send(rb).await?;
        res.json::<T>().await.map_err(network_error)
    }

    pub async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T, ApiError> {
        self.json(self.req(Method::GET, path).timeout(Duration::from_secs(90))).await
    }

    pub async fn post<T: DeserializeOwned, B: Serialize + ?Sized>(&self, path: &str, body: &B) -> Result<T, ApiError> {
        self.json(self.req(Method::POST, path).json(body).timeout(Duration::from_secs(90))).await
    }

    pub async fn put_bytes<T: DeserializeOwned>(&self, path: &str, bytes: Vec<u8>, headers: &[(&str, String)]) -> Result<T, ApiError> {
        let mut rb = self
            .req(Method::PUT, path)
            .header(header::CONTENT_TYPE, "application/octet-stream")
            .header(header::CONTENT_LENGTH, bytes.len())
            .timeout(Duration::from_secs(30 * 60));
        for (k, v) in headers {
            rb = rb.header(*k, v);
        }
        self.json(rb.body(bytes)).await
    }

    /// Generic JSON request used by the UI for account, user and history management.
    pub async fn call(&self, method: Method, path: &str, body: Option<&serde_json::Value>) -> Result<serde_json::Value, ApiError> {
        let mut rb = self.req(method, path).timeout(Duration::from_secs(90));
        if let Some(b) = body {
            rb = rb.json(b);
        }
        let res = self.send(rb).await?;
        let text = res.text().await.map_err(network_error)?;
        if text.trim().is_empty() {
            return Ok(serde_json::Value::Null);
        }
        serde_json::from_str(&text).map_err(|_| ApiError::Network("The server sent a response this app could not read.".into()))
    }

    pub async fn delete(&self, path: &str) -> Result<(), ApiError> {
        self.send(self.req(Method::DELETE, path).timeout(Duration::from_secs(60))).await.map(|_| ())
    }

    /// Starts a download; `from` resumes at a byte offset.
    pub async fn download(&self, path: &str, from: Option<u64>) -> Result<Response, ApiError> {
        let mut rb = self.req(Method::GET, path);
        if let Some(offset) = from.filter(|o| *o > 0) {
            rb = rb.header(header::RANGE, format!("bytes={offset}-"));
        }
        self.send(rb).await
    }

    pub async fn health(&self) -> Result<Health, ApiError> {
        let h: Health = self.get("/api/health").await?;
        if !h.ok || h.service.as_deref() != Some("am-backup") {
            return Err(ApiError::Network("That address is not an AM Backup server.".into()));
        }
        Ok(h)
    }

    /// Uploads a local file to an R2 key: one request when small, multipart otherwise.
    /// `single_path` is the endpoint for single uploads; `on_bytes` reports progress.
    pub async fn upload_file(
        &self,
        file: &Path,
        key: &str,
        single_path: &str,
        single_headers: &[(&str, String)],
        multipart_extra: serde_json::Value,
        on_bytes: &(dyn Fn(u64) + Send + Sync),
    ) -> Result<(), ApiError> {
        let total = tokio::fs::metadata(file).await.map_err(|e| ApiError::Network(format!("Cannot read {}: {e}", file.display())))?.len();
        if total <= SINGLE_UPLOAD_MAX {
            let bytes = tokio::fs::read(file).await.map_err(|e| ApiError::Network(format!("Cannot read {}: {e}", file.display())))?;
            retry(|| {
                let bytes = bytes.clone();
                async move { self.put_bytes::<serde_json::Value>(single_path, bytes, single_headers).await }
            })
            .await?;
            on_bytes(total);
            return Ok(());
        }

        let mut body = serde_json::json!({ "key": key });
        if let (Some(obj), Some(extra)) = (body.as_object_mut(), multipart_extra.as_object()) {
            for (k, v) in extra {
                obj.insert(k.clone(), v.clone());
            }
        }
        let start: UploadStart = retry(|| self.post("/api/uploads", &body)).await?;
        let upload_path = format!("/api/uploads/{}", encode_segment(&start.upload_id));
        let key_q = encode_segment(key);
        let result: Result<Vec<UploadedPart>, ApiError> = async {
            let mut f = tokio::fs::File::open(file).await.map_err(|e| ApiError::Network(e.to_string()))?;
            let mut parts = Vec::new();
            let mut offset = 0u64;
            let mut n = 1u32;
            while offset < total {
                let len = PART_SIZE.min(total - offset) as usize;
                let mut buf = vec![0u8; len];
                f.seek(SeekFrom::Start(offset)).await.map_err(|e| ApiError::Network(e.to_string()))?;
                f.read_exact(&mut buf).await.map_err(|e| ApiError::Network(e.to_string()))?;
                let path = format!("{upload_path}/parts/{n}?key={key_q}");
                let part: UploadedPart = retry(|| {
                    let buf = buf.clone();
                    let path = path.clone();
                    async move { self.put_bytes(&path, buf, &[]).await }
                })
                .await?;
                parts.push(part);
                offset += len as u64;
                on_bytes(offset);
                n += 1;
            }
            Ok(parts)
        }
        .await;
        match result {
            Ok(parts) => {
                let mut done = serde_json::json!({ "key": key, "parts": parts });
                if let (Some(obj), Some(extra)) = (done.as_object_mut(), multipart_extra.as_object()) {
                    for (k, v) in extra {
                        obj.insert(k.clone(), v.clone());
                    }
                }
                let complete_path = format!("{upload_path}/complete");
                retry(|| self.post::<serde_json::Value, _>(&complete_path, &done)).await?;
                Ok(())
            }
            Err(e) => {
                let _ = self.delete(&format!("{upload_path}?key={key_q}")).await;
                Err(e)
            }
        }
    }
}

/// Retries transient failures (network errors, 5xx, 429) with exponential back-off.
pub async fn retry<T, F, Fut>(mut f: F) -> Result<T, ApiError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, ApiError>>,
{
    let mut delay = Duration::from_millis(800);
    let mut attempt = 0;
    loop {
        match f().await {
            Ok(v) => return Ok(v),
            Err(e) if e.retryable() && attempt < 3 => {
                attempt += 1;
                tokio::time::sleep(delay).await;
                delay *= 3;
            }
            Err(e) => return Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segments_are_encoded() {
        assert_eq!(encode_segment("a/b+c=="), "a%2Fb%2Bc%3D%3D");
        assert_eq!(encode_segment("blobs/ab/x"), "blobs%2Fab%2Fx");
    }

    #[test]
    fn base_urls() {
        assert_eq!(normalize_base("localhost:8787/"), "http://localhost:8787");
        assert_eq!(normalize_base("backup.example.com"), "https://backup.example.com");
        assert_eq!(normalize_base(" https://x.workers.dev/ "), "https://x.workers.dev");
    }
}
