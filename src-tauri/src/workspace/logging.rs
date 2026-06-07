use super::{ensure_workspace, read_json, workspace_root, WorkspaceSettings};
use std::{
    fs,
    io::Write,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::AppHandle;

pub(super) fn enforce_log_limit(directory: &Path, limit_bytes: usize) -> Result<(), String> {
    fs::create_dir_all(directory)
        .map_err(|error| format!("Could not create log folder. ({error})"))?;
    let mut files = fs::read_dir(directory)
        .map_err(|error| format!("Could not read log folder. ({error})"))?
        .flatten()
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            if !metadata.is_file() {
                return None;
            }
            Some((
                metadata.modified().unwrap_or(UNIX_EPOCH),
                metadata.len() as usize,
                entry.path(),
            ))
        })
        .collect::<Vec<_>>();
    files.sort_by_key(|(modified, _, _)| *modified);

    let mut total = files.iter().map(|(_, size, _)| size).sum::<usize>();
    let remove_count = if limit_bytes == 0 {
        files.len()
    } else {
        files.len().saturating_sub(1)
    };
    for (_, size, path) in files.iter().take(remove_count) {
        if total <= limit_bytes {
            break;
        }
        fs::remove_file(path)
            .map_err(|error| format!("Could not remove old log file. ({error})"))?;
        total = total.saturating_sub(*size);
    }
    if total > limit_bytes && limit_bytes > 0 {
        if let Some((_, size, path)) = files.last() {
            if path.exists() && *size > limit_bytes {
                let bytes = fs::read(path)
                    .map_err(|error| format!("Could not read active log file. ({error})"))?;
                fs::write(path, &bytes[bytes.len().saturating_sub(limit_bytes)..])
                    .map_err(|error| format!("Could not trim active log file. ({error})"))?;
            }
        }
    }
    Ok(())
}

pub fn append_log(app: &AppHandle, event: &str) -> Result<(), String> {
    let (root, _) = workspace_root(app)?;
    ensure_workspace(&root)?;
    let settings: WorkspaceSettings = read_json(&root.join("settings.json")).unwrap_or_default();
    let limit_bytes = settings.log_limit_mb.saturating_mul(1024 * 1024);
    if limit_bytes == 0 {
        return enforce_log_limit(&root.join("logs"), 0);
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let path = root
        .join("logs")
        .join(format!("api-lantern-{}.log", now / 86_400));
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("Could not open log file. ({error})"))?;
    writeln!(file, "{now} {}", event.replace(['\r', '\n'], " "))
        .map_err(|error| format!("Could not write log file. ({error})"))?;
    enforce_log_limit(&root.join("logs"), limit_bytes)
}
