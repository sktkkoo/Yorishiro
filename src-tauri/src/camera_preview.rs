//! A bounded, local-only preview of the main WebView's already-owned camera stream.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const MAIN: &str = "main";
const PREVIEW: &str = "auxiliary-camera-preview";
const QUERY: &str = "auxiliary=camera-preview";
const STATE_EVENT: &str = "camera-preview-state";
const ACTION_EVENT: &str = "camera-preview-action";
const MAX_JPEG_BYTES: usize = 256 * 1024;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CameraPreviewFrame {
    lease_id: String,
    image_data_url: String,
    last_captured_at: Option<f64>,
    last_shared_at: Option<f64>,
    language: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    delivery_mode: Option<crate::claude_screen_sharing::VisualDeliveryMode>,
    #[serde(default)]
    sequence: u64,
}

impl CameraPreviewFrame {
    fn validate(&self) -> Result<(), String> {
        if !matches!(self.language.as_str(), "en" | "ja")
            || [self.last_captured_at, self.last_shared_at]
                .into_iter()
                .flatten()
                .any(|value| {
                    !value.is_finite() || !(0.0..=9_007_199_254_740_991.0).contains(&value)
                })
        {
            return Err("Invalid preview metadata".into());
        }
        let encoded = self
            .image_data_url
            .strip_prefix("data:image/jpeg;base64,")
            .ok_or("Preview must be an inline JPEG")?;
        if encoded.len() > MAX_JPEG_BYTES.div_ceil(3) * 4 {
            return Err("Preview image is too large".into());
        }
        let jpeg = STANDARD
            .decode(encoded)
            .map_err(|_| "Invalid preview JPEG")?;
        if jpeg.len() > MAX_JPEG_BYTES || !bounded_jpeg(&jpeg) {
            return Err("Preview JPEG must be at most 640 pixels on each edge".into());
        }
        Ok(())
    }
}

// Inspect JPEG segments before any consumer decodes the image; never trust supplied dimensions.
fn bounded_jpeg(bytes: &[u8]) -> bool {
    if !bytes.starts_with(&[0xff, 0xd8]) || !bytes.ends_with(&[0xff, 0xd9]) {
        return false;
    }
    let mut offset = 2;
    while offset + 4 <= bytes.len() {
        if bytes[offset] != 0xff {
            return false;
        }
        while offset < bytes.len() && bytes[offset] == 0xff {
            offset += 1;
        }
        let Some(&marker) = bytes.get(offset) else {
            return false;
        };
        offset += 1;
        if matches!(marker, 0xda | 0xd9 | 0x00) {
            return false;
        }
        let Some(length) = bytes.get(offset..offset + 2) else {
            return false;
        };
        let length = u16::from_be_bytes([length[0], length[1]]) as usize;
        if length < 2 || offset + length > bytes.len() {
            return false;
        }
        if matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf) {
            if length < 8 {
                return false;
            }
            let height = u16::from_be_bytes([bytes[offset + 3], bytes[offset + 4]]);
            let width = u16::from_be_bytes([bytes[offset + 5], bytes[offset + 6]]);
            return (1..=640).contains(&width) && (1..=640).contains(&height);
        }
        offset += length;
    }
    false
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PreviewAction {
    Stop,
    Attach,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RoutedAction {
    lease_id: String,
    action: PreviewAction,
}

#[derive(Default)]
struct PreviewState {
    lease: Option<String>,
    frame: Option<CameraPreviewFrame>,
    sequence: u64,
    opening: bool,
    closing: bool,
    last_publish: Option<Instant>,
}
impl PreviewState {
    fn require_lease(&self, lease: &str) -> Result<(), String> {
        if self.lease.as_deref() == Some(lease) {
            Ok(())
        } else {
            Err("Camera preview is no longer active".into())
        }
    }
    fn clear(&mut self) -> Option<String> {
        self.frame = None;
        self.last_publish = None;
        self.lease.take()
    }
}
#[derive(Default)]
pub struct CameraPreviewState(Mutex<PreviewState>);

fn require_label(actual: &str, required: &str) -> Result<(), String> {
    if actual == required {
        Ok(())
    } else {
        Err("This window cannot perform that preview operation".into())
    }
}
fn allowed_navigation(url: &tauri::Url, main: &tauri::Url) -> bool {
    url.scheme() == main.scheme()
        && url.host_str() == main.host_str()
        && url.port_or_known_default() == main.port_or_known_default()
        && matches!(url.path(), "/" | "/index.html")
        && url.query() == Some(QUERY)
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
}

#[tauri::command]
pub async fn camera_preview_begin(
    window: WebviewWindow,
    state: State<'_, CameraPreviewState>,
) -> Result<String, String> {
    require_label(window.label(), MAIN)?;
    // A native destroy event can arrive after destroy() returns. Do not reuse that window.
    for _ in 0..200 {
        {
            let mut state = state.0.lock().map_err(|_| "Preview state unavailable")?;
            if !state.closing && !state.opening {
                if state.lease.is_some() {
                    return Err("Camera preview is already active".into());
                }
                let lease = uuid::Uuid::new_v4().to_string();
                state.lease = Some(lease.clone());
                return Ok(lease);
            }
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    Err("The previous camera preview is still closing. Try again.".into())
}

#[tauri::command]
pub async fn camera_preview_open(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, CameraPreviewState>,
    lease_id: String,
) -> Result<(), String> {
    require_label(window.label(), MAIN)?;
    let main_url = window.url().map_err(|error| error.to_string())?;
    {
        let mut state = state.0.lock().map_err(|_| "Preview state unavailable")?;
        state.require_lease(&lease_id)?;
        if state.opening || state.closing {
            return Err("Preview window is changing".into());
        }
        if app.get_webview_window(PREVIEW).is_some() {
            return Ok(());
        }
        state.opening = true;
    }
    // No state lock across native creation: platform callbacks may re-enter the application.
    let built = WebviewWindowBuilder::new(
        &app,
        PREVIEW,
        WebviewUrl::App(format!("index.html?{QUERY}").into()),
    )
    .title("Camera preview — Yorishiro")
    .inner_size(280.0, 230.0)
    .min_inner_size(220.0, 180.0)
    .resizable(true)
    .decorations(false)
    .shadow(false)
    .transparent(true)
    .background_color(tauri::webview::Color(0, 0, 0, 0))
    .always_on_top(true)
    .focused(true)
    .skip_taskbar(true)
    .disable_drag_drop_handler()
    .on_navigation(move |url| allowed_navigation(url, &main_url))
    .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
    .build();
    let cancelled = {
        let mut state = state.0.lock().map_err(|_| "Preview state unavailable")?;
        state.opening = false;
        let cancelled = state.require_lease(&lease_id).is_err();
        state.closing = cancelled && built.is_ok();
        cancelled
    };
    let built = built.map_err(|error| error.to_string())?;
    if cancelled {
        built.destroy().map_err(|error| error.to_string())?;
        return Err("Camera preview was cancelled".into());
    }
    Ok(())
}

#[tauri::command]
pub fn camera_preview_revoke(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, CameraPreviewState>,
    lease_id: String,
) -> Result<(), String> {
    require_label(window.label(), MAIN)?;
    let should_close = {
        let mut state = state.0.lock().map_err(|_| "Preview state unavailable")?;
        if state.require_lease(&lease_id).is_ok() {
            state.clear();
            state.closing = state.opening || app.get_webview_window(PREVIEW).is_some();
            !state.opening
        } else {
            false
        }
    };
    if should_close {
        if let Some(window) = app.get_webview_window(PREVIEW) {
            window.destroy().map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn camera_preview_publish(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, CameraPreviewState>,
    mut frame: CameraPreviewFrame,
) -> Result<(), String> {
    require_label(window.label(), MAIN)?;
    frame.validate()?;
    let mut state = state.0.lock().map_err(|_| "Preview state unavailable")?;
    state.require_lease(&frame.lease_id)?;
    let now = Instant::now();
    if state
        .last_publish
        .is_some_and(|last| now.duration_since(last) < Duration::from_millis(125))
    {
        return Ok(());
    }
    state.last_publish = Some(now);
    state.sequence = state.sequence.saturating_add(1);
    frame.sequence = state.sequence;
    state.frame = Some(frame.clone());
    app.emit_to(PREVIEW, STATE_EVENT, frame)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn camera_preview_snapshot(
    window: WebviewWindow,
    state: State<'_, CameraPreviewState>,
) -> Result<Option<CameraPreviewFrame>, String> {
    require_label(window.label(), PREVIEW)?;
    Ok(state
        .0
        .lock()
        .map_err(|_| "Preview state unavailable")?
        .frame
        .clone())
}

#[tauri::command]
pub fn camera_preview_request_action(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, CameraPreviewState>,
    lease_id: String,
    action: PreviewAction,
) -> Result<(), String> {
    require_label(window.label(), PREVIEW)?;
    let state = state.0.lock().map_err(|_| "Preview state unavailable")?;
    state.require_lease(&lease_id)?;
    app.emit_to(MAIN, ACTION_EVENT, RoutedAction { lease_id, action })
        .map_err(|error| error.to_string())
}

pub fn window_destroyed(app: &AppHandle, label: &str) {
    if label != PREVIEW {
        return;
    }
    if let Some(state) = app.try_state::<CameraPreviewState>() {
        let lease = state.0.lock().ok().and_then(|mut state| {
            state.closing = false;
            state.clear()
        });
        if let Some(lease_id) = lease {
            let _ = app.emit_to(
                MAIN,
                ACTION_EVENT,
                RoutedAction {
                    lease_id,
                    action: PreviewAction::Attach,
                },
            );
        }
    }
}
pub fn close_owned_windows(app: &AppHandle) {
    let should_close = if let Some(state) = app.try_state::<CameraPreviewState>() {
        if let Ok(mut state) = state.0.lock() {
            state.clear();
            state.closing = state.opening || app.get_webview_window(PREVIEW).is_some();
            !state.opening
        } else {
            false
        }
    } else {
        false
    };
    if should_close {
        if let Some(window) = app.get_webview_window(PREVIEW) {
            let _ = window.destroy();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn jpeg(width: u16, height: u16) -> Vec<u8> {
        let mut bytes = vec![0xff, 0xd8, 0xff, 0xc0, 0, 8, 8];
        bytes.extend(height.to_be_bytes());
        bytes.extend(width.to_be_bytes());
        bytes.extend([1, 0xff, 0xd9]);
        bytes
    }
    fn frame() -> CameraPreviewFrame {
        CameraPreviewFrame {
            lease_id: "test".into(),
            image_data_url: format!("data:image/jpeg;base64,{}", STANDARD.encode(jpeg(640, 360))),
            last_captured_at: Some(123.0),
            last_shared_at: None,
            language: "ja".into(),
            delivery_mode: None,
            sequence: 0,
        }
    }
    #[test]
    fn on_demand_delivery_survives_native_preview_round_trip() {
        let mut value = frame();
        value.delivery_mode = Some(crate::claude_screen_sharing::VisualDeliveryMode::OnDemand);
        let encoded = serde_json::to_value(&value).unwrap();
        assert_eq!(encoded["deliveryMode"], "on-demand");
        let decoded: CameraPreviewFrame = serde_json::from_value(encoded).unwrap();
        assert_eq!(decoded.delivery_mode, value.delivery_mode);
        assert!(decoded.validate().is_ok());
    }
    #[test]
    fn bounds_and_schema_reject_external_urls_credentials_and_invalid_timestamps() {
        assert!(frame().validate().is_ok());
        for data in [
            jpeg(641, 360),
            jpeg(0, 1),
            vec![0; MAX_JPEG_BYTES + 1],
            vec![0xff, 0xd8, 0xff, 0xc0, 0, 0],
        ] {
            let mut value = frame();
            value.image_data_url = format!("data:image/jpeg;base64,{}", STANDARD.encode(data));
            assert!(value.validate().is_err());
        }
        for url in [
            "https://example.com/camera.jpg",
            "data:image/png;base64,AAAA",
            "data:image/jpeg;base64,!!!",
        ] {
            let mut value = frame();
            value.image_data_url = url.into();
            assert!(value.validate().is_err());
        }
        for time in [f64::NAN, f64::INFINITY, -1.0] {
            let mut value = frame();
            value.last_shared_at = Some(time);
            assert!(value.validate().is_err());
        }
        let mut value = serde_json::to_value(frame()).unwrap();
        value["token"] = "secret".into();
        assert!(serde_json::from_value::<CameraPreviewFrame>(value).is_err());
    }
    #[test]
    fn revocation_prevents_old_opens_publications_and_actions() {
        let mut state = PreviewState {
            lease: Some("first".into()),
            frame: Some(frame()),
            ..Default::default()
        };
        assert!(state.require_lease("first").is_ok());
        assert_eq!(state.clear(), Some("first".into()));
        assert!(state.frame.is_none());
        assert!(state.require_lease("first").is_err());
        state.lease = Some("replacement".into());
        assert!(state.require_lease("first").is_err());
        assert!(state.require_lease("replacement").is_ok());
    }
    #[test]
    fn window_roles_and_navigation_are_fixed() {
        assert!(require_label(PREVIEW, MAIN).is_err());
        assert!(require_label(MAIN, PREVIEW).is_err());
        assert!(require_label("unknown", PREVIEW).is_err());
        let main = tauri::Url::parse("tauri://localhost/").unwrap();
        assert!(allowed_navigation(
            &tauri::Url::parse("tauri://localhost/index.html?auxiliary=camera-preview").unwrap(),
            &main
        ));
        for url in [
            "https://example.com/?auxiliary=camera-preview",
            "tauri://localhost/?auxiliary=screen-sharing-controls",
            "tauri://user@localhost/?auxiliary=camera-preview",
            "tauri://localhost/other?auxiliary=camera-preview",
        ] {
            assert!(!allowed_navigation(&tauri::Url::parse(url).unwrap(), &main));
        }
    }
}
