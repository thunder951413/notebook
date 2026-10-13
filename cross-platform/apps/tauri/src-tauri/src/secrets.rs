//! Secrets (WebDAV app password, sync password, AI keys) in the macOS keychain.
//!
//! All values live in ONE keychain item holding a JSON map. A locally built
//! app has no stable code signature, so macOS asks once per build whether the
//! app may read its keychain item; with a single item that is one prompt
//! instead of one per secret. The decoded map is cached in memory.

use std::collections::BTreeMap;
use std::sync::Mutex;

const SERVICE: &str = "Notebook";
const ACCOUNT: &str = "secrets-v1";

#[derive(Default)]
pub struct Secrets {
    cache: Mutex<Option<BTreeMap<String, String>>>,
}

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, ACCOUNT).map_err(|error| format!("无法访问系统钥匙串：{error}"))
}

impl Secrets {
    fn load(&self) -> Result<BTreeMap<String, String>, String> {
        if let Some(values) = self.cache.lock().unwrap().as_ref() {
            return Ok(values.clone());
        }
        let values = match entry()?.get_password() {
            Ok(text) => serde_json::from_str(&text).map_err(|_| "系统钥匙串中的 Notebook 凭据已损坏".to_string())?,
            Err(keyring::Error::NoEntry) => BTreeMap::new(),
            Err(error) => return Err(format!("无法读取系统钥匙串：{error}")),
        };
        *self.cache.lock().unwrap() = Some(values.clone());
        Ok(values)
    }

    fn store(&self, values: BTreeMap<String, String>) -> Result<(), String> {
        let text = serde_json::to_string(&values).map_err(|error| error.to_string())?;
        entry()?.set_password(&text).map_err(|error| format!("无法写入系统钥匙串：{error}"))?;
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
