//! In-app updates from GitHub Releases (macOS).
//!
//! Releases are unsigned (no Apple Developer ID), so a copy downloaded with a
//! browser is quarantined and needs `xattr -cr` before it opens. The app does
//! that itself: it downloads the zip with its own HTTP client (no quarantine
//! flag), verifies the published SHA-256, extracts it with `ditto`, clears
//! extended attributes, and swaps the bundle after the app has quit.
//!
//! Release contract (see .github/workflows/desktop-tauri.yml):
//!   tag       desktop-v<version>
//!   assets    Notebook-macos-<arch>.zip  and  Notebook-macos-<arch>.zip.sha256
//! The repository is private, so requests use the GitHub token saved in
//! Settings (keychain key `github-release-token`).

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

use crate::AppState;

pub const REPOSITORY: &str = "thunder951413/notebook";
pub const RELEASES_PAGE: &str = "https://github.com/thunder951413/notebook/releases";
const TAG_PREFIX: &str = "desktop-v";

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
    checksum_url: Option<String>,
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
            state: Mutex::new(UpdateState { status: "idle".into(), current_version: version, release_url: RELEASES_PAGE.into(), can_auto_install: true, ..Default::default() }),
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

pub fn asset_name() -> String {
    format!("Notebook-macos-{}.zip", arch())
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

/// Picks the newest published `desktop-v*` release with an asset for this Mac.
pub fn select_release(releases: &[Value], current: &str) -> Option<(ReleaseAssetInfo, Value)> {
    let wanted = asset_name();
    releases
        .iter()
        .filter(|release| release["draft"].as_bool() != Some(true) && release["prerelease"].as_bool() != Some(true))
        .filter_map(|release| {
            let tag = release["tag_name"].as_str()?;
            let version = tag.strip_prefix(TAG_PREFIX)?.to_string();
            let assets = release["assets"].as_array()?;
            let zip = assets.iter().find(|asset| asset["name"].as_str() == Some(wanted.as_str()))?;
            let checksum = assets.iter().find(|asset| asset["name"].as_str() == Some(format!("{wanted}.sha256").as_str()));
            Some((
                ReleaseAssetInfo {
                    version,
                    zip_url: zip["url"].as_str()?.to_string(),
                    checksum_url: checksum.and_then(|asset| asset["url"].as_str()).map(str::to_string),
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
    pub checksum_url: Option<String>,
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
                *state.updater.release.lock().unwrap() = Some(ReleaseAsset { version: info.version.clone(), zip_url: info.zip_url, checksum_url: info.checksum_url, size: info.size });
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
    let state = app.state::<AppState>();
    let token = token(app).await;
    let dir = updates_dir(app);
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建下载目录：{e}"))?;
    let target = dir.join(format!("Notebook-{}.zip", release.version));
    let expected = match &release.checksum_url {
        Some(url) => {
            let text = github_request(&state.http, url, token.as_deref(), "application/octet-stream")
                .send()
                .await
                .and_then(|response| response.error_for_status())
                .map_err(|e| format!("无法下载校验值：{}", crate::webdav::reqwest_error_text(&e.without_url())))?
                .text()
                .await
                .map_err(|e| e.to_string())?;
            Some(text.split_whitespace().next().unwrap_or("").to_lowercase())
        }
        None => None,
    };
    if let Some(expected) = &expected {
        if target.is_file() && sha256_file(&target).ok().as_deref() == Some(expected.as_str()) {
            return Ok(target);
        }
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
    let partial = target.with_extension("zip.part");
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
    if let Some(expected) = expected {
        if expected != actual {
            let _ = std::fs::remove_file(&partial);
            return Err("安装包 SHA-256 校验失败，已删除，请重新下载。".into());
        }
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
fn current_bundle() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let bundle = exe.parent().and_then(Path::parent).and_then(Path::parent).map(Path::to_path_buf).ok_or("无法确定应用位置")?;
    if bundle.extension().and_then(|value| value.to_str()) != Some("app") {
        return Err("当前不是从 .app 运行（开发模式），无法自动安装。".into());
    }
    Ok(bundle)
}

fn run(command: &str, args: &[&str]) -> Result<String, String> {
    let output = std::process::Command::new(command).args(args).output().map_err(|e| format!("{command}：{e}"))?;
    if !output.status.success() {
        return Err(format!("{command} 失败：{}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Prepares the new bundle and starts a detached helper that swaps it in once
/// this process has exited, then reopens the app. Returns after the helper started.
pub fn prepare_install(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let zip = state.updater.downloaded.lock().unwrap().clone().ok_or("更新尚未下载完成")?;
    let version = state.updater.release.lock().unwrap().as_ref().map(|release| release.version.clone()).ok_or("没有待安装的版本")?;
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
    run("/usr/bin/xattr", &["-cr", new_bundle.to_str().ok_or("路径无效")?])?;
    let plist = new_bundle.join("Contents/Info.plist");
    let bundled_version = run("/usr/bin/plutil", &["-extract", "CFBundleShortVersionString", "raw", plist.to_str().ok_or("路径无效")?])?;
    if compare_versions(&bundled_version, &version) != std::cmp::Ordering::Equal {
        return Err(format!("安装包版本（{bundled_version}）与发布版本（{version}）不一致，已取消安装。"));
    }
    // Same volume as the target so the final swap is an atomic rename.
    let incoming = parent.join(format!(".Notebook-update-{version}.app"));
    let _ = std::fs::remove_dir_all(&incoming);
    run("/bin/mv", &[new_bundle.to_str().unwrap(), incoming.to_str().ok_or("路径无效")?]).or_else(|_| run("/usr/bin/ditto", &[new_bundle.to_str().unwrap(), incoming.to_str().unwrap()]))?;

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
    fn selects_newest_published_desktop_release_with_this_macs_asset() {
        let name = asset_name();
        let asset = |tag: &str| json!([{ "name": name, "url": format!("https://api/{tag}/zip"), "size": 10 }, { "name": format!("{name}.sha256"), "url": format!("https://api/{tag}/sum") }]);
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
        assert_eq!(info.checksum_url.as_deref(), Some("https://api/d301/sum"));
        assert!(select_release(&releases, "3.0.1").is_none());
    }
}
