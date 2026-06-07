use super::{ensure_workspace, workspace_root, Environment, SavedRequest};
use serde_json::Value;
use std::{fs, io::Write, path::Path};
use tauri::AppHandle;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

fn add_directory_to_zip(
    zip: &mut ZipWriter<fs::File>,
    root: &Path,
    directory: &Path,
    prefix: &str,
) -> Result<(), String> {
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path.starts_with(root.join("private")) {
            continue;
        }
        if path.is_dir() {
            add_directory_to_zip(zip, root, &path, prefix)?;
        } else {
            let relative = path.strip_prefix(root).map_err(|error| error.to_string())?;
            let archive_path = Path::new(prefix)
                .join(relative)
                .to_string_lossy()
                .replace('\\', "/");
            zip.start_file(archive_path, options)
                .map_err(|error| format!("Could not create ZIP entry. ({error})"))?;
            zip.write_all(&redact_export_bytes(
                relative,
                fs::read(&path).map_err(|error| error.to_string())?,
            )?)
            .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

pub(super) fn redact_export_bytes(relative: &Path, mut bytes: Vec<u8>) -> Result<Vec<u8>, String> {
    if relative.starts_with("environments") {
        if let Ok(mut environment) = serde_json::from_slice::<Environment>(&bytes) {
            for variable in &mut environment.variables {
                if variable.secret {
                    variable.value.clear();
                }
            }
            bytes = serde_json::to_vec_pretty(&environment)
                .map_err(|error| format!("Could not redact environment secrets. ({error})"))?;
        }
    } else if relative.starts_with("requests") {
        if let Ok(mut request) = serde_json::from_slice::<SavedRequest>(&bytes) {
            if let Some(fields) = request.auth_fields.as_object_mut() {
                for key in ["password", "token", "value"] {
                    if fields.contains_key(key) {
                        fields.insert(key.into(), Value::String(String::new()));
                    }
                }
            }
            bytes = serde_json::to_vec_pretty(&request)
                .map_err(|error| format!("Could not redact request secrets. ({error})"))?;
        }
    }
    Ok(bytes)
}

pub fn export_portable(app: &AppHandle, path: &str) -> Result<(), String> {
    let (root, _) = workspace_root(app)?;
    ensure_workspace(&root)?;
    let file = fs::File::create(path)
        .map_err(|error| format!("Could not create portable workspace ZIP. ({error})"))?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    zip.start_file("README.txt", options)
        .map_err(|error| error.to_string())?;
    zip.write_all(b"API Lantern portable workspace\n\nPlace this workspace folder beside an API Lantern portable release. Secrets are intentionally excluded.\n").map_err(|error| error.to_string())?;
    zip.start_file("portable.flag", options)
        .map_err(|error| error.to_string())?;
    add_directory_to_zip(&mut zip, &root, &root, "workspace")?;
    zip.finish()
        .map_err(|error| format!("Could not finish portable workspace ZIP. ({error})"))?;
    Ok(())
}
