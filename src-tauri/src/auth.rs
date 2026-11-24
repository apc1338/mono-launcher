use crate::models::{Account, AccountType, MsaDeviceCode};
use crate::storage;
use chrono::Utc;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use uuid::Uuid;

pub fn offline_uuid(username: &str) -> String {
    let input = format!("OfflinePlayer:{username}");
    let mut digest = md5::compute(input.as_bytes()).0;
    digest[6] = (digest[6] & 0x0f) | 0x30; // version 3
    digest[8] = (digest[8] & 0x3f) | 0x80; // variant 1
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        digest[0], digest[1], digest[2], digest[3],
        digest[4], digest[5],
        digest[6], digest[7],
        digest[8], digest[9],
        digest[10], digest[11], digest[12], digest[13], digest[14], digest[15]
    )
}

pub fn create_offline_account(username: String) -> Result<Account, String> {
    let trimmed = username.trim().to_string();
    if trimmed.len() < 3 || trimmed.len() > 16 {
        return Err("Username must be between 3 and 16 characters".into());
    }
    if !trimmed.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err("Username can only contain Latin letters, digits, and _".into());
    }
    Ok(Account {
        id: Uuid::new_v4().to_string(),
        uuid: offline_uuid(&trimmed),
        username: trimmed,
        account_type: AccountType::Offline,
        access_token: Some("0".into()),
        client_token: None,
        refresh_token: None,
        expires_at: None,
    })
}

#[derive(Serialize)]
struct ElyAuthPayload<'a> {
    username: &'a str,
    password: &'a str,
    #[serde(rename = "clientToken")]
    client_token: &'a str,
    #[serde(rename = "requestUser")]
    request_user: bool,
}

#[derive(Deserialize)]
struct ElyAuthResponse {
    #[serde(rename = "accessToken")]
    access_token: String,
    #[serde(rename = "clientToken")]
    client_token: String,
    #[serde(rename = "selectedProfile")]
    selected_profile: ElyProfile,
}

#[derive(Deserialize)]
struct ElyProfile {
    id: String,
    name: String,
}

#[derive(Deserialize)]
struct ElyErrorResponse {
    #[serde(rename = "errorMessage")]
    error_message: Option<String>,
    error: Option<String>,
}

pub async fn authenticate_elyby(username: String, password: String) -> Result<Account, String> {
    let client = Client::new();
    let client_token = Uuid::new_v4().to_string();
    let payload = ElyAuthPayload {
        username: username.trim(),
        password: &password,
        client_token: &client_token,
        request_user: false,
    };

    let resp = client
        .post("https://authserver.ely.by/auth/authenticate")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Network error connecting to Ely.by: {e}"))?;

    if !resp.status().is_success() {
        let err_body = resp.text().await.unwrap_or_default();
        if let Ok(parsed) = serde_json::from_str::<ElyErrorResponse>(&err_body) {
            return Err(parsed
                .error_message
                .or(parsed.error)
                .unwrap_or_else(|| "Ely.by authentication failed".into()));
        }
        return Err(format!("Ely.by auth failed: {err_body}"));
    }

    let data: ElyAuthResponse = resp
        .json()
        .await
        .map_err(|e| format!("Invalid Ely.by response: {e}"))?;

    let raw_id = data.selected_profile.id.replace('-', "");
    let formatted_uuid = if raw_id.len() == 32 {
        format!(
            "{}-{}-{}-{}-{}",
            &raw_id[0..8],
            &raw_id[8..12],
            &raw_id[12..16],
            &raw_id[16..20],
            &raw_id[20..32]
        )
    } else {
        data.selected_profile.id
    };

    Ok(Account {
        id: Uuid::new_v4().to_string(),
        username: data.selected_profile.name,
        uuid: formatted_uuid,
        account_type: AccountType::Elyby,
        access_token: Some(data.access_token),
        client_token: Some(data.client_token),
        refresh_token: None,
        expires_at: None,
    })
}

#[derive(Deserialize)]
struct AuthlibMeta {
    download_url: String,
}

pub async fn ensure_authlib_injector() -> Result<PathBuf, String> {
    let target = storage::data_root().join("authlib-injector.jar");
    if target.exists() {
        return Ok(target);
    }

    let client = Client::new();
    let url = match client
        .get("https://authlib-injector.yushi.moe/artifact/latest.json")
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            if let Ok(meta) = resp.json::<AuthlibMeta>().await {
                meta.download_url
            } else {
                "https://github.com/yushijinhun/authlib-injector/releases/download/v1.2.5/authlib-injector-1.2.5.jar".to_string()
            }
        }
        _ => "https://github.com/yushijinhun/authlib-injector/releases/download/v1.2.5/authlib-injector-1.2.5.jar".to_string(),
    };

    let bytes = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed downloading authlib-injector: {e}"))?
        .bytes()
        .await
        .map_err(|e| e.to_string())?;

    std::fs::write(&target, &bytes).map_err(|e| e.to_string())?;
    Ok(target)
}

// ---------------------------------------------------------------------------
// Microsoft OAuth 2.0 (Device Code) -> Xbox Live -> XSTS -> Minecraft Services
// ---------------------------------------------------------------------------

const DEFAULT_MSA_CLIENT_ID: &str = "61872cbf-7c83-4536-8528-22d2ddb3df30";

pub fn resolve_msa_client_id() -> Result<String, String> {
    if let Some(id) = storage::load_settings().msa_client_id {
        let t = id.trim().to_string();
        if !t.is_empty() {
            return Ok(t);
        }
    }
    if let Ok(id) = std::env::var("MSA_CLIENT_ID") {
        let t = id.trim().to_string();
        if !t.is_empty() {
            return Ok(t);
        }
    }
    if let Some(id) = option_env!("MSA_CLIENT_ID") {
        let t = id.trim().to_string();
        if !t.is_empty() {
            return Ok(t);
        }
    }
    Ok(DEFAULT_MSA_CLIENT_ID.to_string())
}

fn percent_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for b in input.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn encode_form(pairs: &[(&str, &str)]) -> String {
    pairs
        .iter()
        .map(|(k, v)| format!("{}={}", percent_encode(k), percent_encode(v)))
        .collect::<Vec<_>>()
        .join("&")
}

#[derive(Deserialize)]
struct RawDeviceCodeResp {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    #[serde(default = "default_poll_interval")]
    interval: u64,
}

fn default_poll_interval() -> u64 {
    5
}

#[derive(Deserialize)]
struct MsTokenOk {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
}

#[derive(Deserialize)]
struct MsTokenErr {
    #[serde(default)]
    error: String,
    #[serde(default)]
    error_description: Option<String>,
}

#[derive(Deserialize)]
struct XblResp {
    #[serde(rename = "Token")]
    token: String,
    #[serde(rename = "DisplayClaims")]
    display_claims: XblClaims,
}

#[derive(Deserialize)]
struct XblClaims {
    xui: Vec<XblXui>,
}

#[derive(Deserialize)]
struct XblXui {
    uhs: String,
}

#[derive(Deserialize)]
struct XstsErrResp {
    #[serde(rename = "XErr", default)]
    xerr: u64,
    #[serde(rename = "Message", default)]
    message: Option<String>,
}

#[derive(Deserialize)]
struct McLoginResp {
    access_token: String,
    #[serde(default = "default_mc_expires")]
    expires_in: u64,
}

fn default_mc_expires() -> u64 {
    86400
}

#[derive(Deserialize)]
struct McProfileResp {
    id: String,
    name: String,
}

fn format_uuid_32(raw: &str) -> String {
    let clean = raw.replace('-', "");
    if clean.len() == 32 {
        format!(
            "{}-{}-{}-{}-{}",
            &clean[0..8],
            &clean[8..12],
            &clean[12..16],
            &clean[16..20],
            &clean[20..32]
        )
    } else {
        raw.to_string()
    }
}

pub async fn start_msa_device_flow() -> Result<MsaDeviceCode, String> {
    let client_id = resolve_msa_client_id()?;
    let client = Client::new();
    let body = encode_form(&[
        ("client_id", &client_id),
        ("scope", "XboxLive.signin offline_access"),
    ]);

    let resp = client
        .post("https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("Network error contacting Microsoft OAuth: {e}"))?;

    if !resp.status().is_success() {
        let txt = resp.text().await.unwrap_or_default();
        if let Ok(err) = serde_json::from_str::<MsTokenErr>(&txt) {
            return Err(err.error_description.unwrap_or(err.error));
        }
        return Err(format!("Microsoft device code request failed: {txt}"));
    }

    let raw: RawDeviceCodeResp = resp.json().await.map_err(|e| e.to_string())?;
    Ok(MsaDeviceCode {
        device_code: raw.device_code,
        user_code: raw.user_code,
        verification_uri: raw.verification_uri,
        expires_in: raw.expires_in,
        interval: raw.interval.max(2),
    })
}

pub async fn complete_msa_device_flow(
    device_code: &str,
    interval_sec: u64,
    expires_in_sec: u64,
    cancel: Arc<AtomicBool>,
) -> Result<Account, String> {
    let client_id = resolve_msa_client_id()?;
    let client = Client::new();
    let mut poll_sec = interval_sec.max(2);
    let deadline = std::time::Instant::now()
        + std::time::Duration::from_secs(expires_in_sec.clamp(30, 900));

    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        if std::time::Instant::now() >= deadline {
            return Err("Device code expired. Start sign-in again.".into());
        }

        // Sleep in short slices so user cancellation responds immediately.
        let ticks = poll_sec * 4;
        for _ in 0..ticks {
            if cancel.load(Ordering::Relaxed) {
                return Err("cancelled".into());
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }

        let body = encode_form(&[
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ("client_id", &client_id),
            ("device_code", device_code),
        ]);

        let resp = client
            .post("https://login.microsoftonline.com/consumers/oauth2/v2.0/token")
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(body)
            .send()
            .await
            .map_err(|e| format!("Network error polling Microsoft OAuth: {e}"))?;

        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if status.is_success() {
            let tok: MsTokenOk = serde_json::from_str(&text).map_err(|e| e.to_string())?;
            return exchange_ms_token_for_mc_account(
                &client,
                &tok.access_token,
                tok.refresh_token,
                None,
            )
            .await;
        }

        if let Ok(err) = serde_json::from_str::<MsTokenErr>(&text) {
            match err.error.as_str() {
                "authorization_pending" => continue,
                "slow_down" => {
                    poll_sec += 5;
                    continue;
                }
                "authorization_declined" => {
                    return Err("Sign-in was declined in the browser.".into());
                }
                "expired_token" => {
                    return Err("Device code expired. Start sign-in again.".into());
                }
                _ => {
                    return Err(err.error_description.unwrap_or(err.error));
                }
            }
        }
        return Err(format!("Microsoft OAuth error ({status}): {text}"));
    }
}

async fn exchange_ms_token_for_mc_account(
    client: &Client,
    ms_access_token: &str,
    refresh_token: Option<String>,
    existing_id: Option<String>,
) -> Result<Account, String> {
    // 1. Xbox Live (XBL)
    let xbl_resp = client
        .post("https://user.auth.xboxlive.com/user/authenticate")
        .header("Accept", "application/json")
        .json(&serde_json::json!({
            "Properties": {
                "AuthMethod": "RPS",
                "SiteName": "user.auth.xboxlive.com",
                "RpsTicket": format!("d={ms_access_token}"),
            },
            "RelyingParty": "http://auth.xboxlive.com",
            "TokenType": "JWT",
        }))
        .send()
        .await
        .map_err(|e| format!("Xbox Live auth failed: {e}"))?;

    if !xbl_resp.status().is_success() {
        let code = xbl_resp.status();
        let body = xbl_resp.text().await.unwrap_or_default();
        return Err(format!("Xbox Live authentication error ({code}): {body}"));
    }
    let xbl: XblResp = xbl_resp.json().await.map_err(|e| e.to_string())?;
    let uhs = xbl
        .display_claims
        .xui
        .first()
        .map(|x| x.uhs.clone())
        .ok_or_else(|| "Xbox Live response did not include user hash (uhs)".to_string())?;

    // 2. XSTS
    let xsts_resp = client
        .post("https://xsts.auth.xboxlive.com/xsts/authorize")
        .header("Accept", "application/json")
        .json(&serde_json::json!({
            "Properties": {
                "SandboxId": "RETAIL",
                "UserTokens": [xbl.token],
            },
            "RelyingParty": "rp://api.minecraftservices.com/",
            "TokenType": "JWT",
        }))
        .send()
        .await
        .map_err(|e| format!("XSTS auth failed: {e}"))?;

    if !xsts_resp.status().is_success() {
        let status = xsts_resp.status();
        let body = xsts_resp.text().await.unwrap_or_default();
        if let Ok(xerr) = serde_json::from_str::<XstsErrResp>(&body) {
            let msg = match xerr.xerr {
                2148916233 => "This Microsoft account has no Xbox profile yet. Sign in once at xbox.com to create a Gamertag.",
                2148916235 => "Xbox Live is not available in this account's region.",
                2148916236 | 2148916237 => "Adult verification is required on xbox.com for this account.",
                2148916238 => "Child accounts must be added to a Microsoft Family group by an adult.",
                _ => xerr.message.as_deref().unwrap_or("XSTS authorization failed"),
            };
            return Err(msg.to_string());
        }
        return Err(format!("XSTS error ({status}): {body}"));
    }
    let xsts: XblResp = xsts_resp.json().await.map_err(|e| e.to_string())?;

    // 3. Minecraft Services login_with_xbox
    let mc_resp = client
        .post("https://api.minecraftservices.com/authentication/login_with_xbox")
        .header("Accept", "application/json")
        .json(&serde_json::json!({
            "identityToken": format!("XBL3.0 x={uhs};{}", xsts.token),
        }))
        .send()
        .await
        .map_err(|e| format!("Minecraft Services auth failed: {e}"))?;

    if !mc_resp.status().is_success() {
        let status = mc_resp.status();
        let body = mc_resp.text().await.unwrap_or_default();
        if status.as_u16() == 403 || status.as_u16() == 401 {
            return Err(format!(
                "Minecraft API rejected Xbox token (HTTP {status}). Make sure your Azure App Client ID is approved for Minecraft API access. Details: {body}"
            ));
        }
        return Err(format!("Minecraft login_with_xbox failed ({status}): {body}"));
    }
    let mc_tok: McLoginResp = mc_resp.json().await.map_err(|e| e.to_string())?;

    // 4. Fetch Minecraft Java profile (verifies game ownership)
    let prof_resp = client
        .get("https://api.minecraftservices.com/minecraft/profile")
        .bearer_auth(&mc_tok.access_token)
        .send()
        .await
        .map_err(|e| format!("Failed fetching Minecraft profile: {e}"))?;

    if prof_resp.status().as_u16() == 404 {
        return Err("This Microsoft account does not own Minecraft: Java Edition.".into());
    }
    if !prof_resp.status().is_success() {
        let status = prof_resp.status();
        let body = prof_resp.text().await.unwrap_or_default();
        return Err(format!("Minecraft profile error ({status}): {body}"));
    }
    let profile: McProfileResp = prof_resp.json().await.map_err(|e| e.to_string())?;
    let expires_at = Utc::now().timestamp() + mc_tok.expires_in as i64;

    Ok(Account {
        id: existing_id.unwrap_or_else(|| Uuid::new_v4().to_string()),
        username: profile.name,
        uuid: format_uuid_32(&profile.id),
        account_type: AccountType::Microsoft,
        access_token: Some(mc_tok.access_token),
        client_token: None,
        refresh_token,
        expires_at: Some(expires_at),
    })
}

/// Ensures a Microsoft account has a fresh Minecraft access token before launching.
/// Saves updated tokens back to `accounts.json` when refreshed.
pub async fn refresh_msa_account(acc: &Account) -> Result<Account, String> {
    if let (Some(tok), Some(exp)) = (&acc.access_token, acc.expires_at) {
        if !tok.is_empty() && exp > Utc::now().timestamp() + 300 {
            return Ok(acc.clone());
        }
    }
    let refresh = acc
        .refresh_token
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Microsoft session expired. Sign in to your Microsoft account again.".to_string())?;

    let client_id = resolve_msa_client_id()?;
    let client = Client::new();
    let body = encode_form(&[
        ("grant_type", "refresh_token"),
        ("client_id", &client_id),
        ("refresh_token", refresh),
        ("scope", "XboxLive.signin offline_access"),
    ]);

    let resp = client
        .post("https://login.microsoftonline.com/consumers/oauth2/v2.0/token")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("Failed refreshing Microsoft token: {e}"))?;

    if !resp.status().is_success() {
        return Err("Microsoft session expired. Please sign in again in Accounts.".into());
    }
    let tok: MsTokenOk = resp.json().await.map_err(|e| e.to_string())?;
    let next_refresh = tok.refresh_token.or_else(|| acc.refresh_token.clone());
    let updated = exchange_ms_token_for_mc_account(
        &client,
        &tok.access_token,
        next_refresh,
        Some(acc.id.clone()),
    )
    .await?;

    let mut store = storage::load_accounts();
    if let Some(slot) = store.accounts.iter_mut().find(|a| a.id == acc.id) {
        *slot = updated.clone();
        let _ = storage::save_accounts(&store);
    }
    Ok(updated)
}
