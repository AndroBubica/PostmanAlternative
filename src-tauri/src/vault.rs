use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use argon2::Argon2;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs, path::Path};

#[derive(Deserialize, Serialize)]
struct VaultFile {
    version: u8,
    salt: String,
    nonce: String,
    ciphertext: String,
}

fn decode(value: &str) -> Result<Vec<u8>, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    STANDARD.decode(value).map_err(|error| error.to_string())
}

fn encode(value: &[u8]) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    STANDARD.encode(value)
}

fn key(password: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    let mut key = [0; 32];
    Argon2::default()
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|error| format!("Could not derive vault key. ({error})"))?;
    Ok(key)
}

pub fn load(path: &Path, password: &str) -> Result<HashMap<String, String>, String> {
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let file: VaultFile = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| format!("Invalid vault file. ({e})"))?;
    let salt = decode(&file.salt)?;
    let nonce = decode(&file.nonce)?;
    let cipher = Aes256Gcm::new_from_slice(&key(password, &salt)?).map_err(|e| e.to_string())?;
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            decode(&file.ciphertext)?.as_ref(),
        )
        .map_err(|_| "Incorrect vault password or damaged vault.".to_string())?;
    serde_json::from_slice(&plaintext).map_err(|e| e.to_string())
}

pub fn save(path: &Path, password: &str, entries: &HashMap<String, String>) -> Result<(), String> {
    let mut salt = [0; 16];
    let mut nonce = [0; 12];
    OsRng.fill_bytes(&mut salt);
    OsRng.fill_bytes(&mut nonce);
    let cipher = Aes256Gcm::new_from_slice(&key(password, &salt)?).map_err(|e| e.to_string())?;
    let plaintext = serde_json::to_vec(entries).map_err(|e| e.to_string())?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), plaintext.as_ref())
        .map_err(|e| e.to_string())?;
    let file = VaultFile {
        version: 1,
        salt: encode(&salt),
        nonce: encode(&nonce),
        ciphertext: encode(&ciphertext),
    };
    fs::create_dir_all(path.parent().ok_or("Invalid vault path.")?).map_err(|e| e.to_string())?;
    let temporary = path.with_extension("tmp");
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(&file).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    fs::rename(temporary, path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vault_round_trip_and_wrong_password() {
        let path =
            std::env::temp_dir().join(format!("api-lantern-vault-{}.enc", rand::random::<u64>()));
        let entries = HashMap::from([("token".to_string(), "secret".to_string())]);
        save(&path, "correct horse", &entries).unwrap();
        assert_eq!(load(&path, "correct horse").unwrap(), entries);
        assert!(load(&path, "wrong").is_err());
        let _ = fs::remove_file(path);
    }
}
