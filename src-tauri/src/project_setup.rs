use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectInput {
    pub kind: String,
    pub path: String,
    pub distribution: Option<String>,
}

pub fn project_directory(input: &CreateProjectInput) -> Result<(String, Option<(String, String)>), String> {
    match input.kind.as_str() {
        "windows" => {
            let path = input.path.trim();
            if path.is_empty() || !Path::new(path).is_absolute() {
                return Err("Enter an absolute Windows folder path".into());
            }
            if path.contains('\0') { return Err("Invalid project path".into()); }
            Ok((path.to_owned(), None))
        }
        "wsl" => {
            let distro = input.distribution.as_deref().unwrap_or("Debian").trim();
            if !distro.starts_with(|c: char| c.is_ascii_alphanumeric()) || !distro.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')) {
                return Err("Enter a valid WSL distribution name".into());
            }
            let relative = input.path.trim().replace('\\', "/");
            if relative.is_empty() || relative.starts_with('/') || relative.split('/').any(|part| part.is_empty() || part == "." || part == ".." || part.ends_with([' ', '.']) || part.chars().any(|c| c.is_control() || matches!(c, ':' | '<' | '>' | '"' | '|' | '?' | '*'))) {
                return Err("Enter a folder relative to /var/www/ without . or .. segments".into());
            }
            let linux_path = format!("/var/www/{relative}");
            let unc = format!(r"\\wsl$\{}\var\www\{}", distro, relative.replace('/', "\\"));
            Ok((unc, Some((distro.to_owned(), linux_path))))
        }
        _ => Err("Choose Windows or WSL".into()),
    }
}

pub fn create_project_directory(input: &CreateProjectInput) -> Result<String, String> {
    let (cwd, wsl) = project_directory(input)?;
    if let Some((distro, linux_path)) = wsl {
        #[cfg(windows)]
        {
            let output = std::process::Command::new("wsl.exe")
                .args(["--distribution", &distro, "--exec", "mkdir", "-p", "--", &linux_path])
                .output().map_err(|error| format!("Could not start WSL: {error}"))?;
            if !output.status.success() {
                return Err(format!("Could not create the WSL folder: {}", String::from_utf8_lossy(&output.stderr).trim()));
            }
        }
        #[cfg(not(windows))]
        { let _ = (distro, linux_path); return Err("WSL project setup requires Windows".into()); }
    } else {
        std::fs::create_dir_all(PathBuf::from(&cwd)).map_err(|error| format!("Could not create the project folder: {error}"))?;
    }
    if !Path::new(&cwd).is_dir() { return Err("The project folder is not accessible from Windows".into()); }
    Ok(cwd)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_wsl_path_under_var_www() {
        let input = CreateProjectInput { kind: "wsl".into(), path: "personal-projects/tkss-valencia".into(), distribution: Some("Debian".into()) };
        assert_eq!(project_directory(&input).unwrap(), (r"\\wsl$\Debian\var\www\personal-projects\tkss-valencia".into(), Some(("Debian".into(), "/var/www/personal-projects/tkss-valencia".into()))));
    }

    #[test]
    fn rejects_wsl_traversal_and_absolute_paths() {
        for path in ["../outside", "client/../outside", "/var/www/client", "client//nested", "client:bad"] {
            let input = CreateProjectInput { kind: "wsl".into(), path: path.into(), distribution: Some("Debian".into()) };
            assert!(project_directory(&input).is_err(), "{path}");
        }
    }

    #[test]
    fn rejects_wsl_distribution_options() {
        let input = CreateProjectInput { kind: "wsl".into(), path: "client".into(), distribution: Some("--bad".into()) };
        assert!(project_directory(&input).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn creates_windows_folder() {
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let directory = std::env::temp_dir().join(format!("codex-board-project-setup-{stamp}")).join("new-project");
        let input = CreateProjectInput { kind: "windows".into(), path: directory.to_string_lossy().into_owned(), distribution: None };
        assert_eq!(create_project_directory(&input).unwrap(), input.path);
        assert!(directory.is_dir());
        std::fs::remove_dir_all(directory.parent().unwrap()).unwrap();
    }
}
