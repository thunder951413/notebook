//! Secrets (WebDAV app password, sync password, AI keys) in the system credential store:
//! the macOS keychain, or the Windows Credential Manager.
//!
//! All values live in ONE logical item holding a JSON map. A locally built
//! app has no stable code signature, so macOS asks once per build whether the
//! app may read its keychain item; with a single item that is one prompt
//! instead of one per secret. The decoded map is cached in memory.
//!
//! The Credential Manager stores at most 2560 bytes per credential, so on
//! Windows the JSON is written in numbered pieces (see `blob`).

use std::collections::BTreeMap;
use std::sync::Mutex;

const SERVICE: &str = "Notebook";
const ACCOUNT: &str = "secrets-v1";

#[cfg(windows)]
const STORE: &str = "凭据管理器";
#[cfg(not(windows))]
const STORE: &str = "钥匙串";

#[derive(Default)]
pub struct Secrets {
    cache: Mutex<Option<BTreeMap<String, String>>>,
}

fn entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, account).map_err(|error| format!("无法访问系统{STORE}：{error}"))
}

/// Splits text into pieces of at most `size` characters (never inside a character).
#[cfg_attr(not(windows), allow(dead_code))]
fn split_chunks(text: &str, size: usize) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    chars.chunks(size.max(1)).map(|piece| piece.iter().collect()).collect()
}

/// The JSON text in the credential store.
#[cfg(not(windows))]
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

impl Secrets {
    fn load(&self) -> Result<BTreeMap<String, String>, String> {
        if let Some(values) = self.cache.lock().unwrap().as_ref() {
            return Ok(values.clone());
        }
        let values = match blob::read()? {
            Some(text) => serde_json::from_str(&text).map_err(|_| format!("系统{STORE}中的 Notebook 凭据已损坏"))?,
            None => BTreeMap::new(),
        };
        *self.cache.lock().unwrap() = Some(values.clone());
        Ok(values)
    }

    fn store(&self, values: BTreeMap<String, String>) -> Result<(), String> {
        let text = serde_json::to_string(&values).map_err(|error| error.to_string())?;
        blob::write(&text)?;
        *self.cache.lock().unwrap() = Some(values);
        Ok(())
    }

    pub fn get(&self, key: &str) -> Result<Option<String>, String> {
        Ok(self.load()?.get(key).cloned())
    }

    pub fn set(&self, key: &str, value: &str) -> Result<(), String> {
        if key.is_empty() || key.len() > 300 || value.len() > 100_000 {
            return Err("凭据名称或内容无效".into());
        }
        let mut values = self.load()?;
        if values.get(key).map(String::as_str) == Some(value) {
            return Ok(());
        }
        values.insert(key.to_string(), value.to_string());
        self.store(values)
    }

    pub fn delete(&self, key: &str) -> Result<(), String> {
        let mut values = self.load()?;
        if values.remove(key).is_none() {
            return Ok(());
        }
        self.store(values)
    }
}

#[cfg(test)]
mod tests {
    use super::split_chunks;

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
}
