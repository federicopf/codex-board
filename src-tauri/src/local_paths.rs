use std::path::PathBuf;

#[cfg(windows)]
pub fn resolve_local_path(path: &str) -> Result<PathBuf, String> {
    if path.starts_with('/') {
        // WSL's /mnt/<drive> paths map deterministically to Windows paths. Do
        // this locally instead of starting WSL just to run `wslpath` on every
        // chat/image request (cold WSL startup can cost many seconds).
        let normalized = path.replace('\\', "/");
        if let Some(mounted) = normalized.strip_prefix("/mnt/") {
            let (drive, rest) = mounted.split_once('/').unwrap_or((mounted, ""));
            if drive.len() == 1 && drive.as_bytes()[0].is_ascii_alphabetic() {
                let suffix = if rest.is_empty() { String::new() } else { format!("\\{}", rest.replace('/', "\\")) };
                return Ok(PathBuf::from(format!("{}:{suffix}", drive.to_ascii_uppercase())));
            }
        }
        let output = std::process::Command::new("wsl.exe")
            .args(["--exec", "wslpath", "-w", path])
            .output()
            .map_err(|error| format!("Could not convert the WSL path: {error}"))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
        }
        let converted = String::from_utf8(output.stdout)
            .map_err(|error| format!("Invalid path returned by wslpath: {error}"))?;
        let converted = converted.trim();
        if converted.is_empty() {
            return Err("wslpath returned an empty path".into());
        }
        return Ok(PathBuf::from(converted));
    }
    Ok(PathBuf::from(path))
}

#[cfg(not(windows))]
pub fn resolve_local_path(path: &str) -> Result<PathBuf, String> {
    Ok(PathBuf::from(path))
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    #[test]
    fn resolves_wsl_mounted_drive_paths_to_windows_paths() {
        let path = super::resolve_local_path("/mnt/c/Users/test/output image.png").unwrap();
        assert_eq!(path, std::path::PathBuf::from(r"C:\Users\test\output image.png"));
    }

    #[cfg(not(windows))]
    #[test]
    fn keeps_native_absolute_paths() {
        let path = super::resolve_local_path("/home/test/output.png").unwrap();
        assert_eq!(path, std::path::PathBuf::from("/home/test/output.png"));
    }
}
