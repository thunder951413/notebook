//! In-app updates from GitHub Releases (macOS, Windows, and Linux).
//!
//! Windows: the release carries the NSIS installer. The app downloads it,
//! verifies the SHA-256 and, once it has quit, a hidden PowerShell runs the
//! installer silently (`/S`, per-user, no admin prompt) and reopens the app (`/R`).
//!
//! Releases are unsigned (no Apple Developer ID), so a copy downloaded with a
//! browser is quarantined and needs `xattr -cr` before it opens. The app does
//! that itself: it downloads the zip with its own HTTP client (no quarantine
//! flag), verifies the published SHA-256, extracts it with `ditto`, clears
//! extended attributes, and swaps the bundle after the app has quit.
//!
//! Release contract (see .github/workflows/desktop-tauri.yml):
//!   tag       desktop-v<major>.<minor>.<patch>
//!   assets    Notebook-macos-<arch>.zip           + .sha256 (+ optional .sig)
//!             Notebook-windows-<arch>-setup.exe   + .sha256 (+ optional .sig)
//!             Notebook-linux-<arch>.AppImage      + .sha256 (+ optional .sig)
//!
//! Optional offline Ed25519 signature verification:
//!   When compiled with `NOTEBOOK_UPDATE_PUBLIC_KEY` (32-byte Ed25519 public key
//!   encoded as 64-char hex or base64), `download_inner` additionally requires
//!   `${asset}.sig` (64-byte Ed25519 signature encoded as hex or base64 over the
//!   release binary or its lowercase SHA-256 hex digest) before accepting an update.
//!
//! The repository is public, so no token is needed; a GitHub token saved in
//! Settings (key `github-release-token`) is still sent when there is one.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

use crate::AppState;

pub const REPOSITORY: &str = "thunder951413/notebook";
pub const RELEASES_PAGE: &str = "https://github.com/thunder951413/notebook/releases";
const TAG_PREFIX: &str = "desktop-v";

/// Optional compile-time Ed25519 public key (hex or base64) for offline update
/// signature verification. When unset, mandatory HTTPS + `.sha256` verification runs.
pub const UPDATE_PUBLIC_KEY: Option<&str> = option_env!("NOTEBOOK_UPDATE_PUBLIC_KEY");

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    pub status: String,
    pub current_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub available_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_notes: Option<String>,
    pub release_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress_percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transferred_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<u64>,
    pub can_auto_install: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requires_authentication: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone)]
struct ReleaseAsset {
    version: String,
    zip_url: String,
    checksum_url: String,
    signature_url: Option<String>,
    size: u64,
}

pub struct Updater {
    state: Mutex<UpdateState>,
    release: Mutex<Option<ReleaseAsset>>,
    downloaded: Mutex<Option<PathBuf>>,
    busy: tokio::sync::Mutex<()>,
}

impl Updater {
    pub fn new(version: String) -> Self {
        Self {
            state: Mutex::new(UpdateState {
                status: "idle".into(),
                current_version: version,
                release_url: RELEASES_PAGE.into(),
                can_auto_install: cfg!(any(target_os = "macos", windows)),
                ..Default::default()
            }),
            release: Mutex::new(None),
            downloaded: Mutex::new(None),
            busy: tokio::sync::Mutex::new(()),
        }
    }
    pub fn snapshot(&self) -> UpdateState {
        self.state.lock().unwrap().clone()
    }
}

fn arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    }
}

fn asset_name_for(os: &str, arch: &str) -> String {
    match os {
        "windows" => format!("Notebook-windows-{arch}-setup.exe"),
        "linux" => format!("Notebook-linux-{arch}.AppImage"),
        _ => format!("Notebook-macos-{arch}.zip"),
    }
}

fn package_extension_for(os: &str) -> &'static str {
    match os {
        "windows" => "exe",
        "linux" => "AppImage",
        _ => "zip",
    }
}

pub fn asset_name() -> String {
    if cfg!(windows) {
        asset_name_for("windows", arch())
    } else if cfg!(target_os = "linux") {
        asset_name_for("linux", arch())
    } else {
        asset_name_for("macos", arch())
    }
}

/// File extension of the downloaded package.
fn package_extension() -> &'static str {
    if cfg!(windows) {
        package_extension_for("windows")
    } else if cfg!(target_os = "linux") {
        package_extension_for("linux")
    } else {
        package_extension_for("macos")
    }
}

/// Validates a strict `MAJOR.MINOR.PATCH` version (`^[0-9]+\.[0-9]+\.[0-9]+$`).
/// Rejects pre-release suffixes, build metadata, whitespace, and path separators.
pub fn is_valid_semver(version: &str) -> bool {
    let mut parts = version.split('.');
    let (Some(major), Some(minor), Some(patch), None) = (parts.next(), parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    [major, minor, patch]
        .into_iter()
        .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()) && part.parse::<u64>().is_ok())
}

/// Numeric comparison of dotted versions; pre-release suffixes are ignored.
pub fn compare_versions(left: &str, right: &str) -> std::cmp::Ordering {
    let parts = |value: &str| -> Vec<u64> { value.split('-').next().unwrap_or("").split('.').map(|part| part.parse().unwrap_or(0)).collect() };
    let (a, b) = (parts(left), parts(right));
    for index in 0..a.len().max(b.len()) {
        let ordering = a.get(index).unwrap_or(&0).cmp(b.get(index).unwrap_or(&0));
        if ordering != std::cmp::Ordering::Equal {
            return ordering;
        }
    }
    std::cmp::Ordering::Equal
}

/// Parses the first token of a `.sha256` file and validates that it is a
/// 64-character lowercase hex SHA-256 digest.
fn parse_sha256_checksum(text: &str) -> Result<String, String> {
    let expected = text.split_whitespace().next().unwrap_or("").to_ascii_lowercase();
    if expected.len() != 64 || !expected.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return Err("安装包 SHA-256 校验值格式无效。".into());
    }
    Ok(expected)
}

/// Extracts optional inline signature metadata from a `.sha256` file (e.g. a
/// `sig=<hex-or-base64>` or `# sig: <hex-or-base64>` line) when no separate
/// `.sig` asset URL was published.
fn extract_inline_signature(checksum_text: &str) -> Option<String> {
    for line in checksum_text.lines().skip(1) {
        let trimmed = line.trim().trim_start_matches('#').trim();
        if let Some(rest) = trimmed.strip_prefix("sig=").or_else(|| trimmed.strip_prefix("sig:")) {
            let value = rest.trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

fn decode_fixed_bytes<const N: usize>(raw: &str) -> Option<[u8; N]> {
    let token = raw
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with("untrusted comment:") && !line.starts_with('#') && !line.starts_with("-----"))?;
    let bytes = if token.len() == N * 2 && token.bytes().all(|b| b.is_ascii_hexdigit()) {
        hex::decode(token).ok()?
    } else {
        base64::engine::general_purpose::STANDARD
            .decode(token)
            .or_else(|_| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(token))
            .ok()?
    };
    bytes.try_into().ok()
}

mod ed25519 {
    use sha2::{Digest, Sha512};

    type Fe = [i64; 16];

    const FE_ZERO: Fe = [0; 16];
    const FE_ONE: Fe = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const D: Fe = [
        0x78a3, 0x1359, 0x4dca, 0x75eb, 0xd8ab, 0x4141, 0x0a4d, 0x0070,
        0xe898, 0x7779, 0x4079, 0x8cc7, 0xfe73, 0x2b6f, 0x6cee, 0x5203,
    ];
    const I_SQRT_M1: Fe = [
        0xa0b0, 0x4a0e, 0x1b27, 0xc4ee, 0xe478, 0xad2f, 0x1806, 0x2f43,
        0xd7a7, 0x3dfb, 0x0099, 0x2b4d, 0xdf0b, 0x4fc1, 0x2480, 0x2b83,
    ];
    const L: [u8; 32] = [
        0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10,
    ];
    const BASE_ENCODED: [u8; 32] = [
        0x58, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66,
        0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66,
    ];

    type Point = [Fe; 4];

    fn carry(o: &mut Fe) {
        for i in 0..16 {
            o[i] += 1 << 16;
            let c = o[i] >> 16;
            if i < 15 {
                o[i + 1] += c - 1;
            } else {
                o[0] += 38 * (c - 1);
            }
            o[i] -= c << 16;
        }
    }

    fn add(a: &Fe, b: &Fe) -> Fe {
        let mut out = FE_ZERO;
        for i in 0..16 {
            out[i] = a[i] + b[i];
        }
        out
    }

    fn sub(a: &Fe, b: &Fe) -> Fe {
        let mut out = FE_ZERO;
        for i in 0..16 {
            out[i] = a[i] - b[i];
        }
        out
    }

    fn mul(a: &Fe, b: &Fe) -> Fe {
        let mut t = [0i64; 31];
        for i in 0..16 {
            for j in 0..16 {
                t[i + j] += a[i] * b[j];
            }
        }
        for i in 0..15 {
            t[i] += 38 * t[i + 16];
        }
        let mut out = FE_ZERO;
        out.copy_from_slice(&t[..16]);
        carry(&mut out);
        carry(&mut out);
        out
    }

    fn sqr(a: &Fe) -> Fe {
        mul(a, a)
    }

    fn inv(a: &Fe) -> Fe {
        let mut c = *a;
        for i in (0..=253).rev() {
            c = sqr(&c);
            if i != 2 && i != 4 {
                c = mul(&c, a);
            }
        }
        c
    }

    fn pow2523(a: &Fe) -> Fe {
        let mut c = *a;
        for i in (0..=250).rev() {
            c = sqr(&c);
            if i != 1 {
                c = mul(&c, a);
            }
        }
        c
    }

    fn pack(n: &Fe) -> [u8; 32] {
        let mut t = *n;
        carry(&mut t);
        carry(&mut t);
        carry(&mut t);
        for _ in 0..2 {
            let mut m = FE_ZERO;
            m[0] = t[0] - 0xffed;
            for i in 1..15 {
                m[i] = t[i] - 0xffff - ((m[i - 1] >> 16) & 1);
                m[i - 1] &= 0xffff;
            }
            m[15] = t[15] - 0x7fff - ((m[14] >> 16) & 1);
            let b = (m[15] >> 16) & 1;
            m[14] &= 0xffff;
            for i in 0..16 {
                t[i] ^= (t[i] ^ m[i]) & (b - 1);
            }
        }
        let mut out = [0u8; 32];
        for i in 0..16 {
            out[2 * i] = (t[i] & 0xff) as u8;
            out[2 * i + 1] = (t[i] >> 8) as u8;
        }
        out
    }

    fn unpack_fe(bytes: &[u8; 32]) -> Fe {
        let mut out = FE_ZERO;
        for i in 0..16 {
            out[i] = (bytes[2 * i] as i64) + ((bytes[2 * i + 1] as i64) << 8);
        }
        out[15] &= 0x7fff;
        out
    }

    fn point_add(p: &Point, q: &Point) -> Point {
        let a = mul(&sub(&p[1], &p[0]), &sub(&q[1], &q[0]));
        let b = mul(&add(&p[1], &p[0]), &add(&q[1], &q[0]));
        let d2 = add(&D, &D);
        let c = mul(&mul(&p[3], &q[3]), &d2);
        let d = mul(&p[2], &add(&q[2], &q[2]));
        let e = sub(&b, &a);
        let f = sub(&d, &c);
        let g = add(&d, &c);
        let h = add(&b, &a);
        [mul(&e, &f), mul(&h, &g), mul(&g, &f), mul(&e, &h)]
    }

    fn scalar_mult(p: &Point, scalar: &[u8]) -> Point {
        let mut q: Point = [FE_ZERO, FE_ONE, FE_ONE, FE_ZERO];
        let mut acc = *p;
        for &byte in scalar {
            for bit in 0..8 {
                if (byte >> bit) & 1 == 1 {
                    q = point_add(&q, &acc);
                }
                acc = point_add(&acc, &acc);
            }
        }
        q
    }

    fn unpack_point(s: &[u8; 32]) -> Option<Point> {
        let y = unpack_fe(s);
        let y2 = sqr(&y);
        let u = sub(&y2, &FE_ONE);
        let v = add(&mul(&y2, &D), &FE_ONE);
        // Reject non-canonical y >= p
        let mut canonical_y = pack(&y);
        canonical_y[31] |= s[31] & 0x80;
        if &canonical_y != s {
            return None;
        }
        let vx = mul(&u, &inv(&v));
        let mut x = mul(&vx, &pow2523(&vx));
        let check = sub(&sqr(&x), &vx);
        if pack(&check) != [0u8; 32] {
            x = mul(&x, &I_SQRT_M1);
            if pack(&sub(&sqr(&x), &vx)) != [0u8; 32] {
                return None;
            }
        }
        let x_bytes = pack(&x);
        let x_sign = x_bytes[0] & 1;
        let wanted_sign = (s[31] >> 7) & 1;
        if x_bytes == [0u8; 32] && wanted_sign == 1 {
            return None;
        }
        if x_sign != wanted_sign {
            x = sub(&FE_ZERO, &x);
        }
        Some([x, y, FE_ONE, mul(&x, &y)])
    }

    fn pack_point(p: &Point) -> [u8; 32] {
        let zi = inv(&p[2]);
        let tx = mul(&p[0], &zi);
        let ty = mul(&p[1], &zi);
        let mut out = pack(&ty);
        out[31] ^= (pack(&tx)[0] & 1) << 7;
        out
    }

    fn is_canonical_scalar(s: &[u8; 32]) -> bool {
        for i in (0..32).rev() {
            if s[i] < L[i] {
                return true;
            }
            if s[i] > L[i] {
                return false;
            }
        }
        false
    }

    pub fn verify_with_hasher(pubkey: &[u8; 32], sig: &[u8; 64], feed_message: impl FnOnce(&mut Sha512) -> bool) -> bool {
        let s_bytes: [u8; 32] = sig[32..64].try_into().unwrap();
        let r_bytes: [u8; 32] = sig[0..32].try_into().unwrap();
        if !is_canonical_scalar(&s_bytes) {
            return false;
        }
        let Some(a_point) = unpack_point(pubkey) else {
            return false;
        };
        let Some(r_point) = unpack_point(&r_bytes) else {
            return false;
        };
        let Some(base) = unpack_point(&BASE_ENCODED) else {
            return false;
        };
        let mut hasher = Sha512::new();
        hasher.update(r_bytes);
        hasher.update(pubkey);
        if !feed_message(&mut hasher) {
            return false;
        }
        let k_hash: [u8; 64] = hasher.finalize().into();
        // Check [S]B == R + [k]A  (RFC 8032 §5.1.7)
        let lhs = scalar_mult(&base, &s_bytes);
        let rhs = point_add(&r_point, &scalar_mult(&a_point, &k_hash));
        // Constant-time 32-byte equality on packed Edwards points
        let (left, right) = (pack_point(&lhs), pack_point(&rhs));
        left.iter().zip(right.iter()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
    }
}

/// Verifies the downloaded update artifact against an Ed25519 signature when
/// `public_key` is configured (e.g. via `NOTEBOOK_UPDATE_PUBLIC_KEY`).
/// Accepts signatures over either the lowercase SHA-256 hex digest or the raw
/// binary bytes. When `public_key` is `None`/empty, returns `Ok(())`.
fn verify_release_signature(artifact: &Path, expected_sha256: &str, sig_text: Option<&str>, public_key: Option<&str>) -> Result<(), String> {
    let Some(pk_raw) = public_key.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(());
    };
    let pubkey: [u8; 32] = decode_fixed_bytes(pk_raw).ok_or_else(|| "内置更新公钥格式无效（需要 32 字节 Ed25519 公钥）。".to_string())?;
    let sig_raw = sig_text.map(str::trim).filter(|s| !s.is_empty()).ok_or_else(|| "当前构建要求验证更新签名，但发布缺少 .sig 签名文件。".to_string())?;
    let signature: [u8; 64] = decode_fixed_bytes(sig_raw).ok_or_else(|| "更新签名文件（.sig）格式无效。".to_string())?;
    let verified_digest = ed25519::verify_with_hasher(&pubkey, &signature, |hasher| {
        hasher.update(expected_sha256.as_bytes());
        true
    });
    if verified_digest {
        return Ok(());
    }
    let verified_file = ed25519::verify_with_hasher(&pubkey, &signature, |hasher| {
        let Ok(mut file) = std::fs::File::open(artifact) else { return false };
        std::io::copy(&mut file, hasher).is_ok()
    });
    if verified_file {
        Ok(())
    } else {
        Err("安装包数字签名校验失败，已拒绝更新。".into())
    }
}

fn update(app: &AppHandle, change: impl FnOnce(&mut UpdateState)) -> UpdateState {
    let updater = &app.state::<AppState>().updater;
    let snapshot = {
        let mut state = updater.state.lock().unwrap();
        change(&mut state);
        state.clone()
    };
    let _ = app.emit_to(crate::MAIN, "notebook:update-state", &snapshot);
    snapshot
}

async fn token(app: &AppHandle) -> Option<String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || app.state::<AppState>().secrets.get("github-release-token").ok().flatten())
        .await
        .ok()
        .flatten()
        .filter(|value| !value.trim().is_empty())
}

fn github_request(http: &reqwest::Client, url: &str, token: Option<&str>, accept: &str) -> reqwest::RequestBuilder {
    let mut request = http.get(url).header(reqwest::header::ACCEPT, accept).header("X-GitHub-Api-Version", "2022-11-28");
    if let Some(token) = token {
        request = request.bearer_auth(token.trim());
    }
    request
}

/// Picks the newest published `desktop-v*` release with both the platform binary
/// asset and its `.sha256` checksum asset, and a strict `X.Y.Z` semver tag.
pub fn select_release(releases: &[Value], current: &str) -> Option<(ReleaseAssetInfo, Value)> {
    let wanted = asset_name();
    let wanted_checksum = format!("{wanted}.sha256");
    let wanted_sig = format!("{wanted}.sig");
    releases
        .iter()
        .filter(|release| release["draft"].as_bool() != Some(true) && release["prerelease"].as_bool() != Some(true))
        .filter_map(|release| {
            let tag = release["tag_name"].as_str()?;
            let version = tag.strip_prefix(TAG_PREFIX)?;
            if !is_valid_semver(version) {
                return None;
            }
            let assets = release["assets"].as_array()?;
            let zip = assets.iter().find(|asset| asset["name"].as_str() == Some(wanted.as_str()))?;
            let checksum = assets.iter().find(|asset| asset["name"].as_str() == Some(wanted_checksum.as_str()))?;
            let signature_url = assets
                .iter()
                .find(|asset| asset["name"].as_str() == Some(wanted_sig.as_str()))
                .and_then(|asset| asset["url"].as_str())
                .map(str::to_string);
            Some((
                ReleaseAssetInfo {
                    version: version.to_string(),
                    zip_url: zip["url"].as_str()?.to_string(),
                    checksum_url: checksum["url"].as_str()?.to_string(),
                    signature_url,
                    size: zip["size"].as_u64().unwrap_or(0),
                },
                release.clone(),
            ))
        })
        .filter(|(info, _)| compare_versions(&info.version, current) == std::cmp::Ordering::Greater)
        .max_by(|(left, _), (right, _)| compare_versions(&left.version, &right.version))
}

#[derive(Debug, Clone, PartialEq)]
pub struct ReleaseAssetInfo {
    pub version: String,
    pub zip_url: String,
    pub checksum_url: String,
    pub signature_url: Option<String>,
    pub size: u64,
}

pub async fn check(app: &AppHandle) -> UpdateState {
    let state = app.state::<AppState>();
    let Ok(_guard) = state.updater.busy.try_lock() else { return state.updater.snapshot() };
    let current = state.updater.snapshot().current_version;
    if state.updater.downloaded.lock().unwrap().is_some() {
        return state.updater.snapshot();
    }
    update(app, |s| {
        s.status = "checking".into();
        s.message = Some("正在检查更新…".into());
    });
    let token = token(app).await;
    let url = format!("https://api.github.com/repos/{REPOSITORY}/releases?per_page=30");
    let response = github_request(&state.http, &url, token.as_deref(), "application/vnd.github+json").send().await;
    let checked_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let result: Result<Vec<Value>, (String, bool)> = match response {
        Ok(response) if response.status().is_success() => response.json::<Vec<Value>>().await.map_err(|e| (format!("更新信息无法解析：{e}"), false)),
        Ok(response) if matches!(response.status().as_u16(), 401 | 403 | 404) => Err((
            if token.is_some() { "GitHub 令牌无效或没有读取该仓库的权限，请在下方更新令牌。".into() } else { "代码仓库是私有的：请在下方填写 GitHub 令牌（需要 repo 读取权限）后再检查更新。".into() },
            true,
        )),
        Ok(response) => Err((format!("GitHub 返回 {}", response.status().as_u16()), false)),
        Err(error) => Err((format!("无法连接 GitHub：{}", crate::webdav::reqwest_error_text(&error.without_url())), false)),
    };
    match result {
        Ok(releases) => match select_release(&releases, &current) {
            Some((info, release)) => {
                *state.updater.release.lock().unwrap() = Some(ReleaseAsset {
                    version: info.version.clone(),
                    zip_url: info.zip_url,
                    checksum_url: info.checksum_url,
                    signature_url: info.signature_url,
                    size: info.size,
                });
                update(app, |s| {
                    s.status = "available".into();
                    s.available_version = Some(info.version.clone());
                    s.release_name = release["name"].as_str().map(str::to_string);
                    s.release_date = release["published_at"].as_str().map(str::to_string);
                    s.release_notes = release["body"].as_str().map(str::to_string).filter(|notes| !notes.trim().is_empty());
                    s.release_url = release["html_url"].as_str().unwrap_or(RELEASES_PAGE).to_string();
                    s.checked_at = Some(checked_at.clone());
                    s.requires_authentication = None;
                    s.message = Some(format!("发现新版本 {}，下载后重启即可完成更新。", info.version));
                })
            }
            None => update(app, |s| {
                s.status = "up-to-date".into();
                s.available_version = None;
                s.checked_at = Some(checked_at.clone());
                s.requires_authentication = None;
                s.message = Some("已是最新版本。".into());
            }),
        },
        Err((message, auth)) => update(app, |s| {
            s.status = "error".into();
            s.checked_at = Some(checked_at.clone());
            s.requires_authentication = auth.then_some(true);
            s.message = Some(message.clone());
        }),
    }
}

fn updates_dir(app: &AppHandle) -> PathBuf {
    app.path().app_cache_dir().unwrap_or_else(|_| std::env::temp_dir()).join("updates")
}

pub async fn download(app: &AppHandle) -> UpdateState {
    let state = app.state::<AppState>();
    let Ok(_guard) = state.updater.busy.try_lock() else { return state.updater.snapshot() };
    let Some(release) = state.updater.release.lock().unwrap().clone() else {
        return update(app, |s| {
            s.status = "error".into();
            s.message = Some("没有可下载的新版本，请先检查更新。".into());
        });
    };
    match download_inner(app, &release).await {
        Ok(path) => {
            *state.updater.downloaded.lock().unwrap() = Some(path);
            update(app, |s| {
                s.status = "downloaded".into();
                s.progress_percent = Some(100.0);
                s.message = Some(format!("新版本 {} 已下载并校验，重启应用即可完成更新。", release.version));
            })
        }
        Err(message) => update(app, |s| {
            s.status = "error".into();
            s.message = Some(message.clone());
        }),
    }
}

async fn download_inner(app: &AppHandle, release: &ReleaseAsset) -> Result<PathBuf, String> {
    if !is_valid_semver(&release.version) {
        return Err("更新版本号格式无效".into());
    }
    let state = app.state::<AppState>();
    let token = token(app).await;
    let dir = updates_dir(app);
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建下载目录：{e}"))?;
    let target = dir.join(format!("Notebook-{}.{}", release.version, package_extension()));
    let checksum_text = github_request(&state.http, &release.checksum_url, token.as_deref(), "application/octet-stream")
        .send()
        .await
        .and_then(|response| response.error_for_status())
        .map_err(|e| format!("无法下载校验值：{}", crate::webdav::reqwest_error_text(&e.without_url())))?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    let expected = parse_sha256_checksum(&checksum_text)?;
    let sig_text = match &release.signature_url {
        Some(sig_url) if UPDATE_PUBLIC_KEY.is_some_and(|pk| !pk.trim().is_empty()) => Some(
            github_request(&state.http, sig_url, token.as_deref(), "application/octet-stream")
                .send()
                .await
                .and_then(|response| response.error_for_status())
                .map_err(|e| format!("无法下载签名文件：{}", crate::webdav::reqwest_error_text(&e.without_url())))?
                .text()
                .await
                .map_err(|e| e.to_string())?,
        ),
        _ => extract_inline_signature(&checksum_text),
    };
    if target.is_file() && sha256_file(&target).ok().as_deref() == Some(expected.as_str()) {
        if verify_release_signature(&target, &expected, sig_text.as_deref(), UPDATE_PUBLIC_KEY).is_ok() {
            return Ok(target);
        }
        let _ = std::fs::remove_file(&target);
    }
    update(app, |s| {
        s.status = "downloading".into();
        s.progress_percent = Some(0.0);
        s.transferred_bytes = Some(0);
        s.total_bytes = Some(release.size);
        s.message = Some(format!("正在下载 {}…", release.version));
    });
    let mut response = github_request(&state.http, &release.zip_url, token.as_deref(), "application/octet-stream")
        .timeout(Duration::from_secs(900))
        .send()
        .await
        .and_then(|response| response.error_for_status())
        .map_err(|e| format!("下载失败：{}", crate::webdav::reqwest_error_text(&e.without_url())))?;
    let total = response.content_length().unwrap_or(release.size);
    let partial = target.with_extension(format!("{}.part", package_extension()));
    let mut file = std::fs::File::create(&partial).map_err(|e| format!("无法写入下载文件：{e}"))?;
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut last_percent = -1i64;
    use std::io::Write;
    while let Some(chunk) = response.chunk().await.map_err(|e| format!("下载中断：{}", crate::webdav::reqwest_error_text(&e.without_url())))? {
        file.write_all(&chunk).map_err(|e| format!("无法写入下载文件：{e}"))?;
        hasher.update(&chunk);
        received += chunk.len() as u64;
        let percent = if total > 0 { (received * 100 / total) as i64 } else { 0 };
        if percent != last_percent {
            last_percent = percent;
            update(app, |s| {
                s.progress_percent = Some(percent as f64);
                s.transferred_bytes = Some(received);
                s.total_bytes = Some(total);
            });
        }
    }
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    let actual = hex::encode(hasher.finalize());
    if expected != actual {
        let _ = std::fs::remove_file(&partial);
        return Err("安装包 SHA-256 校验失败，已删除，请重新下载。".into());
    }
    if let Err(err) = verify_release_signature(&partial, &expected, sig_text.as_deref(), UPDATE_PUBLIC_KEY) {
        let _ = std::fs::remove_file(&partial);
        return Err(err);
    }
    std::fs::rename(&partial, &target).map_err(|e| e.to_string())?;
    Ok(target)
}

fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher)?;
    Ok(hex::encode(hasher.finalize()))
}

/// The running bundle: …/Notebook.app/Contents/MacOS/notebook → …/Notebook.app
#[cfg(target_os = "macos")]
fn current_bundle() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let bundle = exe.parent().and_then(Path::parent).and_then(Path::parent).map(Path::to_path_buf).ok_or("无法确定应用位置")?;
    if bundle.extension().and_then(|value| value.to_str()) != Some("app") {
        return Err("当前不是从 .app 运行（开发模式），无法自动安装。".into());
    }
    Ok(bundle)
}

#[cfg(target_os = "macos")]
fn run(command: &str, args: &[&str]) -> Result<String, String> {
    let output = std::process::Command::new(command).args(args).output().map_err(|e| format!("{command}：{e}"))?;
    if !output.status.success() {
        return Err(format!("{command} 失败：{}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Prepares the new bundle and starts a detached helper that swaps it in once
/// this process has exited, then reopens the app. Returns after the helper started.
#[cfg(target_os = "macos")]
pub fn prepare_install(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let zip = state.updater.downloaded.lock().unwrap().clone().ok_or("更新尚未下载完成")?;
    let version = state.updater.release.lock().unwrap().as_ref().map(|release| release.version.clone()).ok_or("没有待安装的版本")?;
    if !is_valid_semver(&version) {
        return Err("更新版本号格式无效".into());
    }
    let current = current_bundle()?;
    let parent = current.parent().ok_or("无法确定应用目录")?.to_path_buf();
    // The swap happens next to the current bundle; make sure that works first.
    let probe = parent.join(format!(".notebook-update-{}", std::process::id()));
    std::fs::create_dir(&probe).map_err(|_| format!("没有权限写入 {}。请从发布页下载后手动替换应用。", parent.display()))?;
    let _ = std::fs::remove_dir(&probe);

    let stage = updates_dir(app).join(format!("stage-{version}"));
    let _ = std::fs::remove_dir_all(&stage);
    std::fs::create_dir_all(&stage).map_err(|e| e.to_string())?;
    run("/usr/bin/ditto", &["-x", "-k", zip.to_str().ok_or("路径无效")?, stage.to_str().ok_or("路径无效")?])?;
    let new_bundle = std::fs::read_dir(&stage)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| path.extension().and_then(|value| value.to_str()) == Some("app"))
        .ok_or("安装包里没有找到 .app")?;
    // Unsigned builds: clear quarantine and other extended attributes.
    let new_bundle_str = new_bundle.to_str().ok_or("路径无效")?;
    run("/usr/bin/xattr", &["-cr", new_bundle_str])?;
    let plist = new_bundle.join("Contents/Info.plist");
    let bundled_version = run("/usr/bin/plutil", &["-extract", "CFBundleShortVersionString", "raw", plist.to_str().ok_or("路径无效")?])?;
    if !is_valid_semver(&bundled_version) || compare_versions(&bundled_version, &version) != std::cmp::Ordering::Equal {
        return Err(format!("安装包版本（{bundled_version}）与发布版本（{version}）不一致，已取消安装。"));
    }
    // Same volume as the target so the final swap is an atomic rename.
    let incoming = parent.join(format!(".Notebook-update-{version}.app"));
    let incoming_str = incoming.to_str().ok_or("路径无效")?;
    let _ = std::fs::remove_dir_all(&incoming);
    run("/bin/mv", &[new_bundle_str, incoming_str]).or_else(|_| run("/usr/bin/ditto", &[new_bundle_str, incoming_str]))?;

    let script = r#"
pid="$1"; current="$2"; incoming="$3"; backup="$2.previous"
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
rm -rf "$backup"
if mv "$current" "$backup" && mv "$incoming" "$current"; then
  xattr -cr "$current" 2>/dev/null
  rm -rf "$backup"
else
  [ -d "$current" ] || mv "$backup" "$current"
  rm -rf "$incoming"
fi
open "$current"
"#;
    let mut command = std::process::Command::new("/bin/sh");
    command
        .arg("-c")
        .arg(script)
        .arg("notebook-update")
        .arg(std::process::id().to_string())
        .arg(&current)
        .arg(&incoming)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command.spawn().map_err(|e| format!("无法启动更新程序：{e}"))?;
    Ok(())
}

/// Starts a hidden helper that waits for this process to exit, runs the
/// downloaded installer silently and lets it reopen the app.
#[cfg(windows)]
pub fn prepare_install(app: &AppHandle) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    // CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP: no console, and not tied to this process.
    const FLAGS: u32 = 0x0800_0000 | 0x0000_0200;
    let state = app.state::<AppState>();
    let installer = state.updater.downloaded.lock().unwrap().clone().ok_or("更新尚未下载完成")?;
    let version = state.updater.release.lock().unwrap().as_ref().map(|release| release.version.clone()).ok_or("没有待安装的版本")?;
    if !is_valid_semver(&version) {
        return Err("更新版本号格式无效".into());
    }
    let script = powershell_install_script(std::process::id(), &installer);
    std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-Command", &script])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .creation_flags(FLAGS)
        .spawn()
        .map_err(|e| format!("无法启动更新程序：{e}"))?;
    Ok(())
}

/// PowerShell text: wait for `pid`, then run the installer with `/S /R`.
#[cfg_attr(not(windows), allow(dead_code))]
fn powershell_install_script(pid: u32, installer: &Path) -> String {
    let quoted = installer.to_string_lossy().replace('\'', "''");
    format!("Wait-Process -Id {pid} -ErrorAction SilentlyContinue; Start-Process -FilePath '{quoted}' -ArgumentList '/S','/R'")
}

#[cfg(not(any(target_os = "macos", windows)))]
pub fn prepare_install(_app: &AppHandle) -> Result<(), String> {
    Err("当前系统暂不支持自动安装，请从发布页下载。".into())
}

/// Background policy: check shortly after launch and every six hours; a found
/// update downloads quietly, and the window is told it is ready to install.
pub fn start_background(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(20)).await;
        loop {
            let state = check(&app).await;
            if state.status == "available" {
                let state = download(&app).await;
                if state.status == "downloaded" {
                    let _ = app.emit_to(crate::MAIN, "notebook:update-ready", state.available_version.clone().unwrap_or_default());
                }
            }
            tokio::time::sleep(Duration::from_secs(6 * 60 * 60)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn compares_versions_numerically() {
        assert_eq!(compare_versions("3.0.10", "3.0.9"), std::cmp::Ordering::Greater);
        assert_eq!(compare_versions("3.1", "3.1.0"), std::cmp::Ordering::Equal);
        assert_eq!(compare_versions("3.0.1-beta", "3.0.0"), std::cmp::Ordering::Greater);
        assert_eq!(compare_versions("2.9.9", "3.0.0"), std::cmp::Ordering::Less);
    }

    #[test]
    fn strict_semver_validation_blocks_traversal_and_prereleases() {
        assert!(is_valid_semver("3.6.2"));
        assert!(is_valid_semver("0.0.1"));
        assert!(is_valid_semver("10.20.300"));
        for invalid in [
            "",
            "3.6",
            "3.6.2.1",
            "v3.6.2",
            "3.6.2-beta.1",
            "99.0.0-../../evil",
            "3.7.0-../../x",
            "3.6.2/../../evil",
            "3.6.2\n",
            "3.-1.0",
        ] {
            assert!(!is_valid_semver(invalid), "{invalid:?} must be rejected");
        }
    }

    #[test]
    fn asset_names_and_extensions_cover_macos_windows_and_linux() {
        assert_eq!(asset_name_for("macos", "arm64"), "Notebook-macos-arm64.zip");
        assert_eq!(asset_name_for("windows", "x64"), "Notebook-windows-x64-setup.exe");
        assert_eq!(asset_name_for("linux", "x64"), "Notebook-linux-x64.AppImage");
        assert_eq!(asset_name_for("linux", "arm64"), "Notebook-linux-arm64.AppImage");
        assert_eq!(package_extension_for("macos"), "zip");
        assert_eq!(package_extension_for("windows"), "exe");
        assert_eq!(package_extension_for("linux"), "AppImage");
    }

    #[test]
    fn the_installer_script_waits_for_the_app_and_survives_quotes() {
        let script = powershell_install_script(4242, Path::new(r"C:\Users\O'Neil\AppData\Local\Notebook\updates\Notebook-3.7.0.exe"));
        assert!(script.starts_with("Wait-Process -Id 4242 "));
        assert!(script.contains(r"'C:\Users\O''Neil\AppData\Local\Notebook\updates\Notebook-3.7.0.exe'"));
        assert!(script.ends_with("-ArgumentList '/S','/R'"));
    }

    #[test]
    fn selects_newest_published_desktop_release_with_this_computers_asset() {
        let name = asset_name();
        let asset = |tag: &str| {
            json!([
                { "name": name, "url": format!("https://api/{tag}/zip"), "size": 10 },
                { "name": format!("{name}.sha256"), "url": format!("https://api/{tag}/sum") }
            ])
        };
        let releases = vec![
            json!({ "tag_name": "v2.9.0", "draft": false, "prerelease": false, "assets": asset("v2.9.0") }),
            json!({ "tag_name": "desktop-v3.0.2", "draft": true, "prerelease": false, "assets": asset("d302") }),
            json!({ "tag_name": "desktop-v3.0.1", "draft": false, "prerelease": false, "assets": asset("d301") }),
            json!({ "tag_name": "desktop-v3.1.0", "draft": false, "prerelease": false, "assets": [] }),
            json!({ "tag_name": "desktop-v2.0.0", "draft": false, "prerelease": false, "assets": asset("d200") }),
        ];
        let (info, _) = select_release(&releases, "3.0.0").unwrap();
        assert_eq!(info.version, "3.0.1");
        assert_eq!(info.zip_url, "https://api/d301/zip");
        assert_eq!(info.checksum_url, "https://api/d301/sum");
        assert!(select_release(&releases, "3.0.1").is_none());
    }

    #[test]
    fn ignores_releases_missing_sha256_checksum_asset() {
        let name = asset_name();
        let releases = vec![
            // Newer version, but CI has not uploaded .sha256 yet (or it is missing)
            json!({
                "tag_name": "desktop-v3.8.0",
                "draft": false,
                "prerelease": false,
                "assets": [{ "name": name, "url": "https://api/d380/bin", "size": 100 }]
            }),
            // Older valid version with both binary and .sha256
            json!({
                "tag_name": "desktop-v3.7.0",
                "draft": false,
                "prerelease": false,
                "assets": [
                    { "name": name, "url": "https://api/d370/bin", "size": 100 },
                    { "name": format!("{name}.sha256"), "url": "https://api/d370/sum" },
                    { "name": format!("{name}.sig"), "url": "https://api/d370/sig" }
                ]
            }),
        ];
        let (info, _) = select_release(&releases, "3.6.2").unwrap();
        assert_eq!(info.version, "3.7.0");
        assert_eq!(info.checksum_url, "https://api/d370/sum");
        assert_eq!(info.signature_url.as_deref(), Some("https://api/d370/sig"));
        // If only the checksum-less release is newer, nothing is selected
        assert!(select_release(&releases[..1], "3.6.2").is_none());
    }

    #[test]
    fn rejects_tags_with_traversal_or_non_numeric_suffixes() {
        let name = asset_name();
        let asset = |tag: &str| {
            json!([
                { "name": name, "url": format!("https://api/{tag}/bin"), "size": 10 },
                { "name": format!("{name}.sha256"), "url": format!("https://api/{tag}/sum") }
            ])
        };
        let releases = vec![
            json!({ "tag_name": "desktop-v3.7.0-../../x", "draft": false, "prerelease": false, "assets": asset("bad1") }),
            json!({ "tag_name": "desktop-v99.0.0-../../evil", "draft": false, "prerelease": false, "assets": asset("bad2") }),
            json!({ "tag_name": "desktop-v3.7.0-rc1", "draft": false, "prerelease": false, "assets": asset("bad3") }),
            json!({ "tag_name": "desktop-v3.7", "draft": false, "prerelease": false, "assets": asset("bad4") }),
        ];
        assert!(select_release(&releases, "3.6.2").is_none());
    }

    #[test]
    fn parses_valid_sha256_and_verifies_optional_ed25519_signatures() {
        let valid_upper = "E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855  Notebook.zip\n";
        assert_eq!(
            parse_sha256_checksum(valid_upper).unwrap(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        for bad in ["", "short", &"z".repeat(64), "<html>not found</html>"] {
            assert!(parse_sha256_checksum(bad).is_err(), "{bad:?} must fail");
        }

        // RFC 8032 §7.1 Test Vector 2 (1-byte message 0x72 = "r")
        let pubkey_hex = "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c";
        let sig_hex = "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00";
        let temp = std::env::temp_dir().join(format!("notebook-sig-test-{}.bin", uuid::Uuid::new_v4()));
        std::fs::write(&temp, [0x72u8]).unwrap();
        let digest = sha256_file(&temp).unwrap();
        // No public key configured -> skipped cleanly
        assert!(verify_release_signature(&temp, &digest, None, None).is_ok());
        // Public key configured, missing .sig -> rejected
        assert!(verify_release_signature(&temp, &digest, None, Some(pubkey_hex)).is_err());
        // Public key configured, valid Ed25519 signature over file -> accepted
        assert!(verify_release_signature(&temp, &digest, Some(sig_hex), Some(pubkey_hex)).is_ok());
        // Tampered file -> rejected
        std::fs::write(&temp, [0x73u8]).unwrap();
        assert!(verify_release_signature(&temp, &digest, Some(sig_hex), Some(pubkey_hex)).is_err());
        let _ = std::fs::remove_file(&temp);
    }
}
