use serde::{Serialize, de::DeserializeOwned};
use std::{fs, path::Path};

pub fn load_json_or_default<T: DeserializeOwned + Default>(path: &Path) -> T {
    read_json(path)
        .or_else(|| read_json(&backup_path(path)))
        .unwrap_or_default()
}

pub fn write_json<T: Serialize + ?Sized>(path: &Path, value: &T) -> Result<(), String> {
    let temporary = path.with_extension("json.tmp");
    let backup = backup_path(path);
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;

    if !path.exists() {
        return fs::rename(temporary, path).map_err(|error| error.to_string());
    }
    if backup.exists() {
        fs::remove_file(&backup).map_err(|error| error.to_string())?;
    }
    fs::rename(path, &backup).map_err(|error| error.to_string())?;
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::rename(&backup, path);
        return Err(error.to_string());
    }
    Ok(())
}

fn read_json<T: DeserializeOwned>(path: &Path) -> Option<T> {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

fn backup_path(path: &Path) -> std::path::PathBuf {
    path.with_extension("json.bak")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn repeated_writes_keep_previous_valid_backup() {
        let directory = std::env::temp_dir().join(format!(
            "codex-board-persistence-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("state.json");
        write_json(&path, &vec![1]).unwrap();
        write_json(&path, &vec![2]).unwrap();
        assert_eq!(load_json_or_default::<Vec<i32>>(&path), vec![2]);
        assert_eq!(read_json::<Vec<i32>>(&backup_path(&path)), Some(vec![1]));
        fs::remove_dir_all(directory).unwrap();
    }
}
