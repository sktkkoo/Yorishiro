use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const LOG_DIRECTORY: &str = "logs";
const LOG_FILE: &str = "work-status-diagnostic.jsonl";
const ROTATED_LOG_FILE: &str = "work-status-diagnostic.jsonl.1";
const MAX_LOG_BYTES: u64 = 512 * 1024;

static LOG_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkStatusDiagnosticEntry {
    event_kind: DiagnosticEventKind,
    session_id: Option<String>,
    thread_id: Option<String>,
    route: Option<DiagnosticRoute>,
    result: Option<DiagnosticResult>,
    reason: Option<DiagnosticReason>,
    work_id: Option<String>,
    status: Option<WorkStatus>,
    previous_status: Option<WorkStatus>,
    active_count: Option<u32>,
    freshness: Option<Freshness>,
    observed_age_seconds: Option<u64>,
    correlation_count: Option<u32>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum DiagnosticRoute {
    LedgerContext,
    MainAgentHandoff,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum DiagnosticResult {
    Enqueued,
    Delivered,
    Failed,
    Observed,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum DiagnosticReason {
    SessionStartSnapshot,
    PostConnectResync,
    LedgerEvent,
    FreshnessBoundary,
    RealtimeHandoffRequest,
    CorrelationResync,
    RealtimeError,
    RealtimeClosed,
    BridgeClosed,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum DiagnosticEventKind {
    ContextInitialEnqueued,
    ContextResyncDelivered,
    ContextEventDelivered,
    ContextDeliveryFailed,
    CorrelationResyncDelivered,
    CorrelationResyncFailed,
    FreshnessRefreshDelivered,
    RealtimeErrorObserved,
    RealtimeClosedObserved,
    BridgeClosedObserved,
    HandoffObserved,
    WorkCreated,
    WorkUpdated,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum WorkStatus {
    Created,
    Running,
    ApprovalRequired,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum Freshness {
    Fresh,
    Aging,
    Stale,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredEntry<'a> {
    timestamp_ms: u128,
    app_version: &'static str,
    event_kind: &'a DiagnosticEventKind,
    session_key: Option<String>,
    thread_key: Option<String>,
    route: &'a Option<DiagnosticRoute>,
    result: &'a Option<DiagnosticResult>,
    reason: &'a Option<DiagnosticReason>,
    work_id: &'a Option<String>,
    status: &'a Option<WorkStatus>,
    previous_status: &'a Option<WorkStatus>,
    active_count: &'a Option<u32>,
    freshness: &'a Option<Freshness>,
    observed_age_seconds: &'a Option<u64>,
    correlation_count: &'a Option<u32>,
}

#[tauri::command]
pub async fn work_status_diagnostic_log(entry: WorkStatusDiagnosticEntry) -> Result<(), String> {
    let home = dirs::home_dir().ok_or_else(|| "home directory not found".to_string())?;
    append_entry(&home.join(".yorishiro"), &entry)
}

fn append_entry(yorishiro_home: &Path, entry: &WorkStatusDiagnosticEntry) -> Result<(), String> {
    let _guard = LOG_LOCK
        .lock()
        .map_err(|_| "work status diagnostic log lock poisoned".to_string())?;
    let log_dir = yorishiro_home.join(LOG_DIRECTORY);
    fs::create_dir_all(&log_dir)
        .map_err(|error| format!("failed to create diagnostic log directory: {error}"))?;
    let path = log_dir.join(LOG_FILE);
    rotate_if_needed(&path, &log_dir.join(ROTATED_LOG_FILE))?;

    let stored = StoredEntry {
        timestamp_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
        app_version: env!("CARGO_PKG_VERSION"),
        event_kind: &entry.event_kind,
        session_key: safe_identifier("session", entry.session_id.as_deref()),
        thread_key: safe_identifier("thread", entry.thread_id.as_deref()),
        route: &entry.route,
        result: &entry.result,
        reason: &entry.reason,
        work_id: &entry.work_id,
        status: &entry.status,
        previous_status: &entry.previous_status,
        active_count: &entry.active_count,
        freshness: &entry.freshness,
        observed_age_seconds: &entry.observed_age_seconds,
        correlation_count: &entry.correlation_count,
    };
    let mut line = serde_json::to_vec(&stored)
        .map_err(|error| format!("failed to encode diagnostic log entry: {error}"))?;
    line.push(b'\n');
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| format!("failed to open diagnostic log: {error}"))?;
    file.write_all(&line)
        .map_err(|error| format!("failed to append diagnostic log: {error}"))
}

fn safe_identifier(namespace: &str, value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    if value.is_empty() {
        return None;
    }
    // Diagnostic correlation needs a stable opaque key, not the original app-server ID.
    // This fixed FNV-1a encoding is deterministic across app runs; it is not an auth token.
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in namespace
        .as_bytes()
        .iter()
        .copied()
        .chain(std::iter::once(0))
        .chain(value.as_bytes().iter().copied())
    {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    Some(format!("{namespace}-{hash:016x}"))
}

fn rotate_if_needed(path: &Path, rotated_path: &Path) -> Result<(), String> {
    let size = match fs::metadata(path) {
        Ok(metadata) => metadata.len(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("failed to inspect diagnostic log: {error}")),
    };
    if size < MAX_LOG_BYTES {
        return Ok(());
    }
    if rotated_path.exists() {
        fs::remove_file(rotated_path)
            .map_err(|error| format!("failed to replace rotated diagnostic log: {error}"))?;
    }
    fs::rename(path, rotated_path)
        .map_err(|error| format!("failed to rotate diagnostic log: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_entry() -> WorkStatusDiagnosticEntry {
        WorkStatusDiagnosticEntry {
            event_kind: DiagnosticEventKind::HandoffObserved,
            session_id: Some("private session label".to_string()),
            thread_id: Some("thread-secret-value".to_string()),
            route: Some(DiagnosticRoute::MainAgentHandoff),
            result: Some(DiagnosticResult::Observed),
            reason: Some(DiagnosticReason::RealtimeHandoffRequest),
            work_id: None,
            status: None,
            previous_status: None,
            active_count: Some(1),
            freshness: None,
            observed_age_seconds: None,
            correlation_count: None,
        }
    }

    #[test]
    fn writes_only_the_allowlisted_metadata() {
        let temp = tempfile::tempdir().expect("tempdir");
        append_entry(temp.path(), &sample_entry()).expect("append");
        let text =
            fs::read_to_string(temp.path().join(LOG_DIRECTORY).join(LOG_FILE)).expect("read");
        let value: serde_json::Value = serde_json::from_str(text.trim()).expect("json");

        assert_eq!(value["eventKind"], "handoff-observed");
        assert_eq!(value["route"], "main-agent-handoff");
        assert_eq!(value["result"], "observed");
        assert_eq!(value["reason"], "realtime-handoff-request");
        assert!(value["sessionKey"]
            .as_str()
            .unwrap()
            .starts_with("session-"));
        assert!(value["threadKey"].as_str().unwrap().starts_with("thread-"));
        assert_eq!(value["activeCount"], 1);
        assert!(value.get("timestampMs").is_some());
        assert!(value.get("appVersion").is_some());
        assert!(value.get("transcript").is_none());
        assert!(value.get("payload").is_none());
        assert!(!text.contains("private session label"));
        assert!(!text.contains("thread-secret-value"));
    }

    #[test]
    fn rotates_a_full_log_before_appending() {
        let temp = tempfile::tempdir().expect("tempdir");
        let log_dir = temp.path().join(LOG_DIRECTORY);
        fs::create_dir_all(&log_dir).expect("mkdir");
        fs::write(log_dir.join(LOG_FILE), vec![b'x'; MAX_LOG_BYTES as usize]).expect("seed");

        append_entry(temp.path(), &sample_entry()).expect("append");

        assert_eq!(
            fs::metadata(log_dir.join(ROTATED_LOG_FILE))
                .expect("rotated")
                .len(),
            MAX_LOG_BYTES
        );
        assert!(fs::metadata(log_dir.join(LOG_FILE)).expect("current").len() < MAX_LOG_BYTES);
    }
}
