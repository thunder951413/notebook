//! Secrets (WebDAV app password, sync password, AI keys, automation token) in
//! the system credential store:
//! - macOS: Keychain (`keyring` apple-native)
//! - Windows: Credential Manager (`keyring` windows-native, chunked)
//! - Linux / other Unix: `secret-tool` (`libsecret` CLI) when available, with
//!   fallback to a `0600`-permissioned local file under `XDG_CONFIG_HOME` or
//!   `~/.config/io.github.notebook.desktop/secrets.json`.
//!
//! All values live in ONE logical item holding a JSON map. A locally built
//! app has no stable code signature, so macOS asks once per build whether the
//! app may read its keychain item; with a single item that is one prompt
//! instead of one per secret. The decoded map is cached in memory and all
//! `get`/`set`/`delete` operations serialize under a single `Mutex` guard across
//! the entire read-modify-write cycle.

use std::collections::BTreeMap;
use std::sync::Mutex;

const SERVICE: &str = "Notebook";
const ACCOUNT: &str = "secrets-v1";

#[cfg(windows)]
const STORE: &str = "凭据管理器";
#[cfg(target_os = "macos")]
const STORE: &str = "钥匙串";
#[cfg(not(any(target_os = "macos", windows)))]
const STORE: &str = "凭据存储";

trait Backend: Send + Sync {
    fn read(&self) -> Result<Option<String>, String>;
    fn write(&self, text: &str) -> Result<(), String>;
}

struct PlatformBackend;

impl Backend for PlatformBackend {
    fn read(&self) -> Result<Option<String>, String> {
        blob::read()
    }
    fn write(&self, text: &str) -> Result<(), String> {
        blob::write(text)
    }
}

pub struct Secrets {
    cache: Mutex<Option<BTreeMap<String, String>>>,
    backend: Box<dyn Backend>,
}

impl Default for Secrets {
    fn default() -> Self {
        Self {
            cache: Mutex::new(None),
            backend: Box::new(PlatformBackend),
        }
    }
}

#[cfg(any(target_os = "macos", windows))]
fn entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, account).map_err(|error| format!("无法访问系统{STORE}：{error}"))
}

/// Splits text into pieces of at most `size` characters (never inside a character).
#[cfg_attr(not(windows), allow(dead_code))]
fn split_chunks(text: &str, size: usize) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    chars.chunks(size.max(1)).map(|piece| piece.iter().collect()).collect()
}

/// macOS: the JSON text in a single Keychain item.
#[cfg(target_os = "macos")]
mod blob {
    use super::{entry, ACCOUNT, STORE};

    pub fn read() -> Result<Option<String>, String> {
        match entry(ACCOUNT)?.get_password() {
            Ok(text) => Ok(Some(text)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(format!("无法读取系统{STORE}：{error}")),
        }
    }

    pub fn write(text: &str) -> Result<(), String> {
        entry(ACCOUNT)?.set_password(text).map_err(|error| format!("无法写入系统{STORE}：{error}"))
    }
}

/// Windows: pieces `secrets-v1.g<generation>.<n>` plus an index entry
/// `secrets-v1` = "<generation>:<count>" that is written last, so a write that
/// is interrupted leaves the previous generation fully readable.
#[cfg(windows)]
mod blob {
    use super::{entry, split_chunks, ACCOUNT, STORE};

    /// UTF-16 on disk: 1000 characters are at most 2000 bytes, under the 2560 limit.
    const CHUNK_CHARS: usize = 1000;

    fn piece(generation: u64, index: usize) -> String {
        format!("{ACCOUNT}.g{generation}.{index}")
    }

    fn index() -> Result<Option<(u64, usize)>, String> {
        let text = match entry(ACCOUNT)?.get_password() {
            Ok(text) => text,
            Err(keyring::Error::NoEntry) => return Ok(None),
            Err(error) => return Err(format!("无法读取系统{STORE}：{error}")),
        };
        let (generation, count) = text.split_once(':').ok_or_else(|| format!("系统{STORE}中的 Notebook 凭据已损坏"))?;
        let parse_error = || format!("系统{STORE}中的 Notebook 凭据已损坏");
        Ok(Some((generation.parse().map_err(|_| parse_error())?, count.parse().map_err(|_| parse_error())?)))
    }

    pub fn read() -> Result<Option<String>, String> {
        let Some((generation, count)) = index()? else { return Ok(None) };
        let mut text = String::new();
        for number in 0..count {
            let part = entry(&piece(generation, number))?.get_password().map_err(|error| format!("无法读取系统{STORE}：{error}"))?;
            text.push_str(&part);
        }
        Ok(Some(text))
    }

    pub fn write(text: &str) -> Result<(), String> {
        let previous = index().ok().flatten();
        let generation = previous.map_or(1, |(generation, _)| generation + 1);
        let pieces = split_chunks(text, CHUNK_CHARS);
        for (number, part) in pieces.iter().enumerate() {
            entry(&piece(generation, number))?.set_password(part).map_err(|error| format!("无法写入系统{STORE}：{error}"))?;
        }
        entry(ACCOUNT)?.set_password(&format!("{generation}:{}", pieces.len())).map_err(|error| format!("无法写入系统{STORE}：{error}"))?;
        // The old generation is garbage now; failing to remove it only wastes a few entries.
        if let Some((old_generation, old_count)) = previous {
            for number in 0..old_count {
                if let Ok(old) = entry(&piece(old_generation, number)) {
                    let _ = old.delete_credential();
                }
            }
        }
        Ok(())
    }
}

/// Shared `0600` atomic file helpers used by the Linux/Unix fallback store.
#[cfg(unix)]
#[cfg_attr(target_os = "macos", allow(dead_code))]
mod unix_file {
    use std::io::Write;
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
    use std::path::Path;

    pub fn read_0600(path: &Path) -> Result<Option<String>, String> {
        match std::fs::read_to_string(path) {
            Ok(text) => {
                let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
                if text.trim().is_empty() {
                    Ok(None)
                } else {
                    Ok(Some(text))
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(format!("无法读取本地凭据文件：{err}")),
        }
    }

    pub fn write_0600(path: &Path, text: &str) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            let mut builder = std::fs::DirBuilder::new();
            builder.recursive(true).mode(0o700);
            builder.create(parent).map_err(|err| format!("无法创建凭据目录：{err}"))?;
        }
        let tmp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        let write_result = (|| -> std::io::Result<()> {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&tmp)?;
            file.write_all(text.as_bytes())?;
            file.sync_all()?;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
            std::fs::rename(&tmp, path)
        })();
        if let Err(err) = write_result {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("无法写入本地凭据文件：{err}"));
        }
        Ok(())
    }
}

/// Linux / other Unix: uses `secret-tool` (`libsecret` CLI: `store`/`lookup`/`clear`)
/// when available, falling back to `~/.config/io.github.notebook.desktop/secrets.json`
/// (or `$XDG_CONFIG_HOME/io.github.notebook.desktop/secrets.json`) with `0600` permissions.
#[cfg(not(any(target_os = "macos", windows)))]
mod blob {
    use std::io::Write;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};

    use super::{unix_file, ACCOUNT, SERVICE};

    fn fallback_path() -> Result<PathBuf, String> {
        let config_root = std::env::var_os("XDG_CONFIG_HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME")
                    .filter(|value| !value.is_empty())
                    .map(|home| PathBuf::from(home).join(".config"))
            })
            .ok_or_else(|| "无法确定本地配置目录（缺少 XDG_CONFIG_HOME 或 HOME）".to_string())?;
        Ok(config_root.join("io.github.notebook.desktop").join("secrets.json"))
    }

    fn secret_tool_lookup() -> Option<String> {
        let output = Command::new("secret-tool")
            .args(["lookup", "service", SERVICE, "account", ACCOUNT])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let text = String::from_utf8(output.stdout).ok()?;
        (!text.trim().is_empty()).then_some(text)
    }

    fn secret_tool_store(text: &str) -> bool {
        let Ok(mut child) = Command::new("secret-tool")
            .args(["store", "--label=Notebook", "service", SERVICE, "account", ACCOUNT])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        else {
            return false;
        };
        if let Some(mut stdin) = child.stdin.take() {
            if stdin.write_all(text.as_bytes()).is_err() {
                let _ = child.wait();
                return false;
            }
        }
        child.wait().map_or(false, |status| status.success())
    }

    fn secret_tool_clear() {
        let _ = Command::new("secret-tool")
            .args(["clear", "service", SERVICE, "account", ACCOUNT])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    pub fn read() -> Result<Option<String>, String> {
        if let Some(text) = secret_tool_lookup() {
            return Ok(Some(text));
        }
        let path = fallback_path()?;
        unix_file::read_0600(&path)
    }

    pub fn write(text: &str) -> Result<(), String> {
        let path = fallback_path()?;
        if text == "{}" {
            secret_tool_clear();
            let _ = std::fs::remove_file(&path);
            return Ok(());
        }
        if secret_tool_store(text) {
            // Remove any stale fallback file if libsecret is active.
            let _ = std::fs::remove_file(&path);
            return Ok(());
        }
        unix_file::write_0600(&path, text)
    }
}

impl Secrets {
    fn ensure_loaded<'a>(&self, guard: &'a mut Option<BTreeMap<String, String>>) -> Result<&'a mut BTreeMap<String, String>, String> {
        if guard.is_none() {
            let values = match self.backend.read()? {
                Some(text) => serde_json::from_str(&text).map_err(|_| format!("系统{STORE}中的 Notebook 凭据已损坏"))?,
                None => BTreeMap::new(),
            };
            *guard = Some(values);
        }
        Ok(guard.as_mut().unwrap())
    }

    pub fn get(&self, key: &str) -> Result<Option<String>, String> {
        let mut guard = self.cache.lock().unwrap();
        let values = self.ensure_loaded(&mut guard)?;
        Ok(values.get(key).cloned())
    }

    pub fn set(&self, key: &str, value: &str) -> Result<(), String> {
        if key.is_empty() || key.len() > 300 || value.len() > 100_000 {
            return Err("凭据名称或内容无效".into());
        }
        let mut guard = self.cache.lock().unwrap();
        let values = self.ensure_loaded(&mut guard)?;
        if values.get(key).map(String::as_str) == Some(value) {
            return Ok(());
        }
        let mut next = values.clone();
        next.insert(key.to_string(), value.to_string());
        let text = serde_json::to_string(&next).map_err(|error| error.to_string())?;
        self.backend.write(&text)?;
        *values = next;
        Ok(())
    }

    pub fn delete(&self, key: &str) -> Result<(), String> {
        let mut guard = self.cache.lock().unwrap();
        let values = self.ensure_loaded(&mut guard)?;
        if !values.contains_key(key) {
            return Ok(());
        }
        let mut next = values.clone();
        next.remove(key);
        let text = serde_json::to_string(&next).map_err(|error| error.to_string())?;
        self.backend.write(&text)?;
        *values = next;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::{Arc, Barrier, Mutex};

    use super::{split_chunks, Backend, Secrets};

    #[derive(Default)]
    struct MemoryBackend(Mutex<Option<String>>);

    impl Backend for MemoryBackend {
        fn read(&self) -> Result<Option<String>, String> {
            Ok(self.0.lock().unwrap().clone())
        }
        fn write(&self, text: &str) -> Result<(), String> {
            *self.0.lock().unwrap() = Some(text.to_string());
            Ok(())
        }
    }

    #[test]
    fn splits_on_character_boundaries_and_joins_back() {
        let text = "密码🔐abc".repeat(700);
        let pieces = split_chunks(&text, 1000);
        assert!(pieces.len() > 1);
        assert!(pieces.iter().all(|piece| piece.chars().count() <= 1000));
        assert_eq!(pieces.concat(), text);
        assert_eq!(split_chunks("", 1000), Vec::<String>::new());
        assert_eq!(split_chunks("abc", 0), vec!["a", "b", "c"]);
    }

    #[test]
    fn serializes_concurrent_set_and_delete_without_clobbering() {
        let secrets = Arc::new(Secrets {
            cache: Mutex::new(None),
            backend: Box::new(MemoryBackend::default()),
        });
        secrets.set("stale", "drop-me").unwrap();
        let workers = 16usize;
        let barrier = Arc::new(Barrier::new(workers + 1));
        let mut handles = Vec::new();
        for i in 0..workers {
            let secrets = secrets.clone();
            let barrier = barrier.clone();
            handles.push(std::thread::spawn(move || {
                barrier.wait();
                secrets.set(&format!("key-{i}"), &format!("val-{i}")).unwrap();
                let _ = secrets.get(&format!("key-{i}")).unwrap();
            }));
        }
        {
            let secrets = secrets.clone();
            let barrier = barrier.clone();
            handles.push(std::thread::spawn(move || {
                barrier.wait();
                secrets.delete("stale").unwrap();
            }));
        }
        for handle in handles {
            handle.join().unwrap();
        }
        assert_eq!(secrets.get("stale").unwrap(), None);
        for i in 0..workers {
            assert_eq!(secrets.get(&format!("key-{i}")).unwrap().as_deref(), Some(format!("val-{i}").as_str()));
        }
        let persisted: BTreeMap<String, String> = serde_json::from_str(&secrets.backend.read().unwrap().unwrap()).unwrap();
        assert_eq!(persisted.len(), workers);
    }

    #[cfg(unix)]
    #[test]
    fn unix_fallback_file_uses_strict_0600_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("notebook-secrets-test-{}", uuid::Uuid::new_v4()));
        let path = dir.join("secrets.json");
        assert_eq!(super::unix_file::read_0600(&path).unwrap(), None);
        super::unix_file::write_0600(&path, r#"{"k":"v"}"#).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        assert_eq!(super::unix_file::read_0600(&path).unwrap().as_deref(), Some(r#"{"k":"v"}"#));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
