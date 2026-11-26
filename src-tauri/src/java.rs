use crate::models::{DetectedJava, LaunchProgressEvent};
use crate::storage;
use futures_util::StreamExt;
use reqwest::Client;
use serde::Deserialize;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Emitter};

pub fn required_java_major(mc_version: &str) -> u32 {
    let trimmed = mc_version.trim();

    // Weekly snapshots like "26w05a", "25w14a", "24w14a", "21w19a"
    if let Some(w_idx) = trimmed.find('w') {
        if w_idx == 2 {
            if let Ok(year) = trimmed[..2].parse::<u32>() {
                if year >= 26 {
                    return 25;
                }
                if year >= 24 {
                    return 21;
                }
                if year >= 21 {
                    return 17;
                }
                return 8;
            }
        }
    }

    let parts: Vec<u32> = trimmed
        .split('.')
        .filter_map(|p| {
            let digits: String = p.chars().take_while(|c| c.is_ascii_digit()).collect();
            digits.parse::<u32>().ok()
        })
        .collect();

    if let Some(&first) = parts.first() {
        // 2026+ drop numbering (26.1, 26.2, 26.3, ...) requires Java 25
        if first >= 26 {
            return 25;
        }
        if first == 1 && parts.len() >= 2 {
            let minor = parts[1];
            let patch = parts.get(2).copied().unwrap_or(0);
            if minor <= 16 {
                return 8;
            }
            if minor < 20 || (minor == 20 && patch < 5) {
                return 17;
            }
            return 21;
        }
    }
    21
}

fn probe_java_binary(path: &Path, managed: bool) -> Option<DetectedJava> {
    if !path.exists() {
        return None;
    }
    let mut cmd = Command::new(path);
    cmd.arg("-version");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let out = cmd.output().ok()?;
    let stderr = String::from_utf8_lossy(&out.stderr);
    let stdout = String::from_utf8_lossy(&out.stdout);
    let combined = format!("{stderr}\n{stdout}");

    // Skip noise like "Picked up JAVA_TOOL_OPTIONS: ..." that may precede the version line.
    let ver_line = combined
        .lines()
        .find(|l| l.contains(" version \""))?
        .trim()
        .to_string();
    let quote_start = ver_line.find('"')?;
    let quote_end = ver_line[quote_start + 1..].find('"')?;
    let version_string = ver_line[quote_start + 1..quote_start + 1 + quote_end].to_string();

    let major = if let Some(rest) = version_string.strip_prefix("1.") {
        rest.split('.').next()?.parse::<u32>().ok()?
    } else {
        version_string
            .split(|c: char| !c.is_ascii_digit())
            .next()?
            .parse::<u32>()
            .ok()?
    };

    Some(DetectedJava {
        major,
        version_string,
        path: path.to_string_lossy().to_string(),
        managed,
    })
}

fn is_managed(path: &Path) -> bool {
    let runtimes = storage::data_root().join("runtimes");
    path.starts_with(&runtimes)
}

/// Turns a user-supplied path (java.exe, javaw.exe, JDK dir or its bin dir) into a java.exe path.
fn resolve_java_exe(input: &Path) -> Option<PathBuf> {
    if input.is_file() {
        let is_javaw = input
            .file_name()
            .map(|n| n.to_string_lossy().eq_ignore_ascii_case("javaw.exe"))
            .unwrap_or(false);
        if is_javaw {
            let sibling = input.with_file_name("java.exe");
            if sibling.is_file() {
                return Some(sibling);
            }
        }
        return Some(input.to_path_buf());
    }
    if input.is_dir() {
        for rel in [Path::new("bin").join("java.exe"), PathBuf::from("java.exe")] {
            let c = input.join(rel);
            if c.is_file() {
                return Some(c);
            }
        }
        return find_java_exe_in_dir(input);
    }
    None
}

/// Validates a manually chosen Java location by actually running `java -version`.
pub fn probe_java_path(input: &str) -> Result<DetectedJava, String> {
    let cleaned = input.trim().trim_matches('"');
    if cleaned.is_empty() {
        return Err("Path is empty".to_string());
    }
    let exe = resolve_java_exe(Path::new(cleaned))
        .ok_or_else(|| "java.exe not found at this location".to_string())?;
    let managed = is_managed(&exe);
    probe_java_binary(&exe, managed)
        .ok_or_else(|| "This file is not a working Java runtime".to_string())
}

/// Collects `<dir>/bin/java.exe` for `dir` itself and for sub-directories up to `depth` levels.
fn scan_root(root: &Path, depth: u32, out: &mut Vec<PathBuf>) {
    let direct = root.join("bin").join("java.exe");
    if direct.is_file() {
        out.push(direct);
    }
    if depth == 0 {
        return;
    }
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                scan_root(&p, depth - 1, out);
            }
        }
    }
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).map(PathBuf::from).filter(|p| !p.as_os_str().is_empty())
}

pub fn detect_javas() -> Vec<DetectedJava> {
    let mut paths: Vec<PathBuf> = Vec::new();

    // 1. Managed runtimes in Mono/runtimes/java-{major}
    let runtimes_dir = storage::data_root().join("runtimes");
    if let Ok(entries) = fs::read_dir(&runtimes_dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                if let Some(java_exe) = find_java_exe_in_dir(&p) {
                    paths.push(java_exe);
                }
            }
        }
    }

    // 2. Paths the user configured manually in settings
    let settings = storage::load_settings();
    for p in [
        &settings.java_8_path,
        &settings.java_17_path,
        &settings.java_21_path,
        &settings.java_25_path,
    ]
    .into_iter()
    .flatten()
    {
        if let Some(exe) = resolve_java_exe(Path::new(p)) {
            paths.push(exe);
        }
    }

    // 3. Vendor install dirs in Program Files (both 64 and 32 bit)
    let vendors = [
        "Eclipse Adoptium",
        "Eclipse Foundation",
        "AdoptOpenJDK",
        "Java",
        "Microsoft",
        "Zulu",
        "BellSoft",
        "Amazon Corretto",
        "Semeru",
        "IBM",
        "GraalVM",
        "Oracle",
        "Temurin",
        "OpenJDK",
        "Android\\Android Studio",
        "JetBrains",
    ];
    for env in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
        if let Some(pf) = env_path(env) {
            for v in vendors {
                scan_root(&pf.join(v), 2, &mut paths);
            }
        }
    }
    scan_root(Path::new(r"C:\Java"), 2, &mut paths);

    // 4. Per-user installs: IntelliJ, Gradle toolchains, Scoop, local programs, Minecraft launcher runtimes
    if let Some(home) = env_path("USERPROFILE") {
        scan_root(&home.join(".jdks"), 2, &mut paths);
        scan_root(&home.join(".gradle").join("jdks"), 2, &mut paths);
        scan_root(&home.join(".sdkman").join("candidates").join("java"), 2, &mut paths);
        scan_root(&home.join("scoop").join("apps"), 3, &mut paths);
    }
    if let Some(local) = env_path("LOCALAPPDATA") {
        scan_root(&local.join("Programs"), 3, &mut paths);
        // New Minecraft launcher (Store/standalone) keeps runtimes in its package folder
        if let Ok(entries) = fs::read_dir(local.join("Packages")) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with("Microsoft.4297127D64EC6") {
                    scan_root(&entry.path().join("LocalCache").join("Local").join("runtime"), 4, &mut paths);
                }
            }
        }
    }
    if let Some(roaming) = env_path("APPDATA") {
        scan_root(&roaming.join(".minecraft").join("runtime"), 4, &mut paths);
    }

    // 5. JAVA_HOME and PATH
    if let Some(jh) = env_path("JAVA_HOME") {
        scan_root(&jh, 0, &mut paths);
    }
    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let c = dir.join("java.exe");
            if c.is_file() {
                paths.push(c);
            }
        }
    }

    // De-duplicate (case-insensitive) before spawning anything
    let mut seen = std::collections::HashSet::new();
    let candidates: Vec<PathBuf> = paths
        .into_iter()
        .filter(|p| seen.insert(p.to_string_lossy().to_lowercase().replace('/', "\\")))
        .collect();

    // Each probe spawns a JVM (~0.3-1s+), so run them in parallel.
    let mut found: Vec<DetectedJava> = std::thread::scope(|s| {
        let handles: Vec<_> = candidates
            .iter()
            .map(|p| {
                let managed = is_managed(p);
                s.spawn(move || probe_java_binary(p, managed))
            })
            .collect();
        handles
            .into_iter()
            .filter_map(|h| h.join().ok().flatten())
            .collect()
    });

    // Same real runtime reached via different paths (e.g. PATH shim) -> keep one per version string + path tail is not reliable, so only sort
    found.sort_by(|a, b| a.major.cmp(&b.major).then_with(|| a.path.cmp(&b.path)));
    found
}
fn find_java_exe_in_dir(dir: &Path) -> Option<PathBuf> {
    let direct = dir.join("bin").join("java.exe");
    if direct.exists() {
        return Some(direct);
    }
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let sub = entry.path().join("bin").join("java.exe");
            if sub.exists() {
                return Some(sub);
            }
        }
    }
    None
}

#[derive(Deserialize)]
struct AdoptiumAsset {
    binary: AdoptiumBinary,
}

#[derive(Deserialize)]
struct AdoptiumBinary {
    package: AdoptiumPackage,
}

#[derive(Deserialize)]
struct AdoptiumPackage {
    link: String,
    size: u64,
}

pub async fn download_java_runtime(
    app: &AppHandle,
    major: u32,
    instance_id: Option<&str>,
) -> Result<String, String> {
    let target_dir = storage::data_root().join("runtimes").join(format!("java-{major}"));
    if let Some(existing) = find_java_exe_in_dir(&target_dir) {
        return Ok(existing.to_string_lossy().to_string());
    }

    let url = format!(
        "https://api.adoptium.net/v3/assets/latest/{major}/hotspot?architecture=x64&image_type=jre&os=windows&vendor=eclipse"
    );
    let client = Client::builder()
        .user_agent("MonoLauncher/0.1.0")
        .build()
        .map_err(|e| e.to_string())?;

    let assets: Vec<AdoptiumAsset> = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Adoptium API error: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Adoptium JSON error: {e}"))?;

    let pkg = &assets
        .first()
        .ok_or_else(|| format!("No Temurin JRE {major} build found for Windows x64"))?
        .binary
        .package;

    let zip_path = storage::data_root()
        .join("runtimes")
        .join(format!("java-{major}.zip"));

    let resp = client
        .get(&pkg.link)
        .send()
        .await
        .map_err(|e| format!("Failed downloading Java {major}: {e}"))?;

    let total = resp.content_length().unwrap_or(pkg.size);
    let mut file = fs::File::create(&zip_path).map_err(|e| e.to_string())?;
    let mut stream = resp.bytes_stream();
    let mut downloaded: u64 = 0;

    while let Some(chunk) = stream.next().await {
        let data = chunk.map_err(|e| e.to_string())?;
        file.write_all(&data).map_err(|e| e.to_string())?;
        downloaded += data.len() as u64;
        if let Some(iid) = instance_id {
            let _ = app.emit(
                "launch-progress",
                LaunchProgressEvent {
                    instance_id: iid.to_string(),
                    stage: "java".into(),
                    current: downloaded,
                    total,
                    message: format!("Java {major}"),
                },
            );
        }
    }
    drop(file);

    fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;
    let zip_file = fs::File::open(&zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(zip_file).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let Some(out_rel) = entry.enclosed_name() else {
            continue;
        };
        let out_path = target_dir.join(out_rel);
        if entry.is_dir() {
            fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut outfile = fs::File::create(&out_path).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut outfile).map_err(|e| e.to_string())?;
        }
    }
    let _ = fs::remove_file(&zip_path);

    let java_exe = find_java_exe_in_dir(&target_dir)
        .ok_or_else(|| format!("java.exe not found after extracting Java {major}"))?;
    Ok(java_exe.to_string_lossy().to_string())
}

pub async fn resolve_java_for_instance(
    app: &AppHandle,
    mc_version: &str,
    override_major: Option<u32>,
    override_path: Option<&str>,
    instance_id: &str,
) -> Result<String, String> {
    if let Some(p) = override_path {
        let cleaned = p.trim().trim_matches('"');
        if !cleaned.is_empty() {
            if let Some(exe) = resolve_java_exe(Path::new(cleaned)) {
                return Ok(exe.to_string_lossy().to_string());
            }
            return Err(format!("Custom Java path not found: {cleaned}"));
        }
    }
    let needed = override_major.unwrap_or_else(|| required_java_major(mc_version));
    let settings = storage::load_settings();
    let configured = match needed {
        8 => settings.java_8_path,
        17 => settings.java_17_path,
        21 => settings.java_21_path,
        25 => settings.java_25_path,
        _ => None,
    };
    if let Some(p) = configured {
        if let Some(exe) = resolve_java_exe(Path::new(p.trim().trim_matches('"'))) {
            return Ok(exe.to_string_lossy().to_string());
        }
    }
    let detected = detect_javas();
    if let Some(exact) = detected.iter().find(|j| j.major == needed) {
        return Ok(exact.path.clone());
    }
    // Only fall back to a newer Java automatically when user did NOT force a specific version
    if override_major.is_none() && needed >= 21 {
        if let Some(newer) = detected.iter().find(|j| j.major >= needed) {
            return Ok(newer.path.clone());
        }
    }
    download_java_runtime(app, needed, Some(instance_id)).await
}
