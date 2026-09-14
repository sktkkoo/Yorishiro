//! Host-owned auxiliary UI. A window kind selects a bundled view; callers never supply a URL.
//! Only the main view publishes state, and auxiliary actions go back to that same owner.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const MAIN_LABEL: &str = "main";
const CONTROLS_LABEL: &str = "auxiliary-screen-sharing-controls";
const STATE_EVENT: &str = "auxiliary-window-state";
const ACTION_EVENT: &str = "auxiliary-window-action";

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AuxiliaryWindowKind {
    ScreenSharingControls,
}

impl AuxiliaryWindowKind {
    fn label(self) -> &'static str {
        match self {
            Self::ScreenSharingControls => CONTROLS_LABEL,
        }
    }

    fn route(self) -> &'static str {
        match self {
            Self::ScreenSharingControls => "screen-sharing-controls",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SharedDisplay {
    id: u32,
    name: String,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum SharingSourceKind {
    #[default]
    Screen,
    Camera,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ScreenSourceKind {
    #[default]
    Display,
    Window,
    Region,
}

/// Deliberately excludes image data, agent/thread identifiers, arbitrary error text, and credentials.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScreenSharingSnapshot {
    #[serde(default)]
    ui_colors: std::collections::BTreeMap<String, String>,
    revision: String,
    pointer_revision: String,
    available: bool,
    active: bool,
    busy: bool,
    pointers_enabled: bool,
    pointers_ready: bool,
    #[serde(default = "default_preview_visible")]
    preview_visible: bool,
    sources: Vec<SharedDisplay>,
    #[serde(default)]
    source_kind: SharingSourceKind,
    #[serde(default)]
    screen_source_kind: ScreenSourceKind,
    #[serde(default)]
    region: Option<crate::screen_capture::ScreenCaptureRegion>,
    source_id: Option<u32>,
    interval_seconds: u16,
    #[serde(default = "default_contact_sheet_frame_count")]
    contact_sheet_frame_count: u8,
    has_error: bool,
    permission_kind: Option<crate::media_permissions::MediaPermissionKind>,
    last_observed_at: Option<u64>,
    language: String,
}

fn default_preview_visible() -> bool {
    true
}

fn default_contact_sheet_frame_count() -> u8 {
    16
}

impl ScreenSharingSnapshot {
    fn validate(&self) -> Result<(), String> {
        if self.ui_colors.len() > 20
            || self.ui_colors.iter().any(|(key, value)| {
                !key.starts_with("--yorishiro-") || key.len() > 64 || value.len() > 128
            })
        {
            return Err("Invalid auxiliary UI colors".into());
        }
        if self.revision.is_empty()
            || self.revision.len() > 80
            || self.pointer_revision.is_empty()
            || self.pointer_revision.len() > 80
        {
            return Err("Invalid auxiliary state revision".into());
        }
        if !(10..=180).contains(&self.interval_seconds) {
            return Err("Viewing interval must be between 10 and 180 seconds".into());
        }
        if !matches!(self.contact_sheet_frame_count, 4 | 9 | 16 | 25) {
            return Err("Contact sheet frame count must be 4, 9, 16, or 25".into());
        }
        if self.sources.len() > 64 || self.sources.iter().any(|source| source.name.len() > 800) {
            return Err("Invalid display list".into());
        }
        if let Some(region) = self.region {
            region.validate_display(region.display_width, region.display_height)?;
        }
        if self.language != "en" && self.language != "ja" {
            return Err("Unsupported auxiliary language".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum ScreenSharingAction {
    Start,
    Stop,
    RefreshSources,
    ClearAnnotations,
    RetryPointers,
    SetPointersEnabled {
        enabled: bool,
    },
    SetPreviewVisible {
        visible: bool,
    },
    SelectSourceKind {
        #[serde(rename = "sourceKind")]
        source_kind: SharingSourceKind,
    },
    SelectScreenSourceKind {
        #[serde(rename = "screenSourceKind")]
        screen_source_kind: ScreenSourceKind,
    },
    SelectRegion,
    SelectSource {
        #[serde(rename = "sourceId")]
        source_id: u32,
    },
    SetInterval {
        #[serde(rename = "intervalSeconds")]
        interval_seconds: u16,
    },
    SetContactSheetFrameCount {
        #[serde(rename = "contactSheetFrameCount")]
        contact_sheet_frame_count: u8,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuxiliaryActionRequest {
    version: u64,
    pointer_revision: Option<String>,
    action: ScreenSharingAction,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedSnapshot {
    version: u64,
    snapshot: ScreenSharingSnapshot,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RoutedAction {
    revision: String,
    pointer_revision: String,
    action: ScreenSharingAction,
}

#[derive(Default)]
struct AuxiliaryState {
    version: u64,
    snapshot: Option<PublishedSnapshot>,
}

#[derive(Default)]
pub struct AuxiliaryWindowsState(Mutex<AuxiliaryState>);

fn require_label(actual: &str, required: &str) -> Result<(), String> {
    if actual == required {
        Ok(())
    } else {
        Err("This window cannot perform that auxiliary operation".into())
    }
}

fn is_allowed_navigation(url: &tauri::Url, main_url: &tauri::Url, query: &str) -> bool {
    // url::Origin is opaque for tauri:// on macOS, so compare its actual authority instead.
    url.scheme() == main_url.scheme()
        && url.host_str() == main_url.host_str()
        && url.port_or_known_default() == main_url.port_or_known_default()
        && matches!(url.path(), "/" | "/index.html")
        && url.query() == Some(query)
        && url.username().is_empty()
        && url.password().is_none()
}

fn validate_action(
    published: &PublishedSnapshot,
    request: &AuxiliaryActionRequest,
) -> Result<(), String> {
    let pointer_setting = matches!(
        &request.action,
        ScreenSharingAction::SetPointersEnabled { .. } | ScreenSharingAction::RetryPointers
    );
    let current_revision = if pointer_setting {
        request.pointer_revision.as_deref() == Some(published.snapshot.pointer_revision.as_str())
    } else {
        published.version == request.version
    };
    if !current_revision {
        return Err("Sharing settings changed. Please try again.".into());
    }
    let snapshot = &published.snapshot;
    match &request.action {
        ScreenSharingAction::Start
            if !snapshot.available
                || (snapshot.source_kind != SharingSourceKind::Camera
                    && snapshot.screen_source_kind == ScreenSourceKind::Display
                    && !snapshot.pointers_ready)
                || snapshot.active
                || snapshot.busy
                || ((snapshot.source_kind == SharingSourceKind::Camera
                    || snapshot.screen_source_kind != ScreenSourceKind::Region)
                    && !snapshot
                        .sources
                        .iter()
                        .any(|source| Some(source.id) == snapshot.source_id)) =>
        {
            Err("Screen sharing is not ready to start".into())
        }
        ScreenSharingAction::SetPointersEnabled { .. }
        | ScreenSharingAction::RetryPointers
        | ScreenSharingAction::ClearAnnotations
            if snapshot.source_kind == SharingSourceKind::Camera
                || snapshot.screen_source_kind != ScreenSourceKind::Display =>
        {
            Err("Desktop pointers are not available for camera sharing".into())
        }
        ScreenSharingAction::SetPointersEnabled { .. } if !snapshot.pointers_ready => {
            Err("Screen pointer settings are not ready".into())
        }
        ScreenSharingAction::RetryPointers if snapshot.pointers_ready || !snapshot.has_error => {
            Err("Screen pointer settings do not need initialization".into())
        }
        ScreenSharingAction::SelectRegion
            if snapshot.source_kind == SharingSourceKind::Camera
                || snapshot.screen_source_kind != ScreenSourceKind::Region
                || snapshot.active
                || snapshot.busy
                || snapshot.source_id.is_none() =>
        {
            Err("Select an available display before choosing a region".into())
        }
        ScreenSharingAction::SelectScreenSourceKind { .. }
            if snapshot.source_kind == SharingSourceKind::Camera || snapshot.busy =>
        {
            Err("Screen source selection is not ready".into())
        }
        ScreenSharingAction::SelectSource { source_id }
            if snapshot.active
                || snapshot.busy
                || !snapshot
                    .sources
                    .iter()
                    .any(|source| source.id == *source_id) =>
        {
            Err("Stop sharing before selecting an available display".into())
        }
        ScreenSharingAction::RefreshSources if snapshot.active || snapshot.busy => {
            Err("Stop sharing before refreshing displays".into())
        }
        ScreenSharingAction::SetInterval { interval_seconds }
            if !(10..=180).contains(interval_seconds) =>
        {
            Err("Viewing interval must be between 10 and 180 seconds".into())
        }
        ScreenSharingAction::SetContactSheetFrameCount {
            contact_sheet_frame_count,
        } if !matches!(contact_sheet_frame_count, 4 | 9 | 16 | 25) => {
            Err("Contact sheet frame count must be 4, 9, 16, or 25".into())
        }
        _ => Ok(()),
    }
}

/// Explicitly opening controls is the only path that changes auxiliary focus.
#[tauri::command]
pub async fn auxiliary_window_open(
    app: AppHandle,
    window: WebviewWindow,
    kind: AuxiliaryWindowKind,
) -> Result<(), String> {
    require_label(window.label(), MAIN_LABEL)?;
    if let Some(existing) = app.get_webview_window(kind.label()) {
        existing.unminimize().map_err(|error| error.to_string())?;
        existing.show().map_err(|error| error.to_string())?;
        return existing.set_focus().map_err(|error| error.to_string());
    }
    let main_url = window.url().map_err(|error| error.to_string())?;
    let query = format!("auxiliary={}", kind.route());
    let resource = format!("index.html?{query}");
    WebviewWindowBuilder::new(&app, kind.label(), WebviewUrl::App(resource.into()))
        .title("Screen sharing — Yorishiro")
        .inner_size(360.0, 530.0)
        .min_inner_size(320.0, 400.0)
        .resizable(true)
        .always_on_top(true)
        .focused(true)
        .accept_first_mouse(true)
        .skip_taskbar(true)
        .disable_drag_drop_handler()
        .on_navigation(move |url| is_allowed_navigation(url, &main_url, &query))
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build()
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn auxiliary_window_publish(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AuxiliaryWindowsState>,
    snapshot: ScreenSharingSnapshot,
) -> Result<(), String> {
    require_label(window.label(), MAIN_LABEL)?;
    snapshot.validate()?;
    let published = {
        let mut state = state.0.lock().map_err(|error| error.to_string())?;
        state.version = state.version.saturating_add(1);
        let published = PublishedSnapshot {
            version: state.version,
            snapshot,
        };
        state.snapshot = Some(published.clone());
        published
    };
    // Never show or focus a window as a side effect of a state refresh or sharing stop.
    app.emit_to(CONTROLS_LABEL, STATE_EVENT, published)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn auxiliary_window_snapshot(
    window: WebviewWindow,
    state: State<'_, AuxiliaryWindowsState>,
) -> Result<Option<PublishedSnapshot>, String> {
    require_label(window.label(), CONTROLS_LABEL)?;
    Ok(state
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .snapshot
        .clone())
}

#[tauri::command]
pub fn auxiliary_window_request_action(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AuxiliaryWindowsState>,
    request: AuxiliaryActionRequest,
) -> Result<(), String> {
    require_label(window.label(), CONTROLS_LABEL)?;
    let routed = {
        let state = state.0.lock().map_err(|error| error.to_string())?;
        let published = state
            .snapshot
            .as_ref()
            .ok_or("The main window is not ready")?;
        validate_action(published, &request)?;
        RoutedAction {
            revision: published.snapshot.revision.clone(),
            pointer_revision: published.snapshot.pointer_revision.clone(),
            action: request.action,
        }
    };
    if app.get_webview_window(MAIN_LABEL).is_none() {
        return Err("The main window is closed".into());
    }
    app.emit_to(MAIN_LABEL, ACTION_EVENT, routed)
        .map_err(|error| error.to_string())
}

/// Called when the owning main window is destroyed, including native close and app shutdown.
pub fn close_owned_windows(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(CONTROLS_LABEL) {
        let _ = window.destroy();
    }
    if let Some(state) = app.try_state::<AuxiliaryWindowsState>() {
        if let Ok(mut state) = state.0.lock() {
            state.snapshot = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn published() -> PublishedSnapshot {
        PublishedSnapshot {
            version: 7,
            snapshot: ScreenSharingSnapshot {
                ui_colors: Default::default(),
                revision: "main-owner-revision".into(),
                pointer_revision: "pointer-owner-revision".into(),
                available: true,
                active: false,
                busy: false,
                pointers_enabled: true,
                pointers_ready: true,
                preview_visible: true,
                sources: vec![SharedDisplay {
                    id: 12,
                    name: "Display 1".into(),
                }],
                source_kind: SharingSourceKind::Screen,
                screen_source_kind: ScreenSourceKind::Display,
                region: None,
                source_id: Some(12),
                interval_seconds: 30,
                contact_sheet_frame_count: 16,
                has_error: false,
                permission_kind: None,
                last_observed_at: None,
                language: "ja".into(),
            },
        }
    }

    #[test]
    fn restricted_sources_require_selection_and_reject_desktop_pointers() {
        let mut state = published();
        let request = |action| AuxiliaryActionRequest {
            version: 7,
            pointer_revision: Some("pointer-owner-revision".into()),
            action,
        };
        state.snapshot.pointers_ready = false;
        state.snapshot.screen_source_kind = ScreenSourceKind::Window;
        assert!(validate_action(&state, &request(ScreenSharingAction::Start)).is_ok());
        assert!(validate_action(&state, &request(ScreenSharingAction::ClearAnnotations)).is_err());
        state.snapshot.screen_source_kind = ScreenSourceKind::Region;
        assert!(validate_action(&state, &request(ScreenSharingAction::Start)).is_ok());
        assert!(validate_action(&state, &request(ScreenSharingAction::SelectRegion)).is_ok());
        state.snapshot.region = Some(crate::screen_capture::ScreenCaptureRegion {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 100.0,
            display_width: 1440.0,
            display_height: 900.0,
        });
        assert!(validate_action(&state, &request(ScreenSharingAction::Start)).is_ok());
    }

    #[test]
    fn region_start_opens_picker_without_a_preselected_display_or_rectangle() {
        let mut state = published();
        state.snapshot.screen_source_kind = ScreenSourceKind::Region;
        state.snapshot.source_id = None;
        state.snapshot.sources.clear();
        state.snapshot.pointers_ready = false;
        let request = AuxiliaryActionRequest {
            version: 7,
            pointer_revision: None,
            action: ScreenSharingAction::Start,
        };
        assert!(validate_action(&state, &request).is_ok());
        state.snapshot.busy = true;
        assert!(validate_action(&state, &request).is_err());
        state.snapshot.busy = false;
        state.snapshot.active = true;
        assert!(validate_action(&state, &request).is_err());
        state.snapshot.active = false;
        state.snapshot.available = false;
        assert!(validate_action(&state, &request).is_err());
        state.snapshot.available = true;
        state.snapshot.screen_source_kind = ScreenSourceKind::Window;
        assert!(validate_action(&state, &request).is_err());
    }

    #[test]
    fn three_minute_interval_round_trips_through_native_payloads() {
        let mut snapshot = published().snapshot;
        snapshot.interval_seconds = 180;
        let json = serde_json::to_value(&snapshot).unwrap();
        let decoded: ScreenSharingSnapshot = serde_json::from_value(json).unwrap();
        assert_eq!(decoded.interval_seconds, 180);
        assert!(decoded.validate().is_ok());
        let request: AuxiliaryActionRequest = serde_json::from_value(serde_json::json!({
            "version": 7,
            "action": { "type": "set-interval", "intervalSeconds": 180 }
        }))
        .unwrap();
        assert!(validate_action(&published(), &request).is_ok());
    }

    #[test]
    fn only_the_intended_window_can_publish_or_request() {
        assert!(require_label(MAIN_LABEL, MAIN_LABEL).is_ok());
        assert!(require_label(CONTROLS_LABEL, MAIN_LABEL).is_err());
        assert!(require_label(MAIN_LABEL, CONTROLS_LABEL).is_err());
        assert!(require_label("untrusted", CONTROLS_LABEL).is_err());
    }

    #[test]
    fn preview_visibility_supports_both_sources_during_capture() {
        let mut state = published();
        let request = AuxiliaryActionRequest {
            version: state.version,
            pointer_revision: None,
            action: ScreenSharingAction::SetPreviewVisible { visible: false },
        };
        assert!(validate_action(&state, &request).is_ok());
        state.snapshot.active = true;
        state.snapshot.busy = true;
        assert!(validate_action(&state, &request).is_ok());
        state.snapshot.source_kind = SharingSourceKind::Camera;
        state.snapshot.active = true;
        state.snapshot.busy = true;
        assert!(validate_action(&state, &request).is_ok());
        let mut json = serde_json::to_value(&state.snapshot).unwrap();
        json.as_object_mut().unwrap().remove("previewVisible");
        assert!(
            serde_json::from_value::<ScreenSharingSnapshot>(json)
                .unwrap()
                .preview_visible
        );
        state.version += 1;
        assert!(validate_action(&state, &request).is_err());
    }

    #[test]
    fn rejects_unknown_window_kinds_and_image_or_credential_fields() {
        assert!(serde_json::from_str::<AuxiliaryWindowKind>("\"https://example.com\"").is_err());
        let mut json = serde_json::to_value(published().snapshot).unwrap();
        for field in ["imageDataUrl", "token", "ownerKey", "error"] {
            json[field] = serde_json::json!("must not cross this bridge");
            assert!(serde_json::from_value::<ScreenSharingSnapshot>(json.clone()).is_err());
            json.as_object_mut().unwrap().remove(field);
        }
    }

    #[test]
    fn navigation_accepts_the_bundled_view_on_tauri_and_dev_origins_only() {
        let query = "auxiliary=screen-sharing-controls";
        for origin in [
            "tauri://localhost",
            "http://localhost:1430",
            "http://tauri.localhost",
        ] {
            let main = tauri::Url::parse(&format!("{origin}/")).unwrap();
            let bundled = tauri::Url::parse(&format!("{origin}/index.html?{query}")).unwrap();
            assert!(is_allowed_navigation(&bundled, &main, query));
            for destination in [
                format!("https://example.com/index.html?{query}"),
                format!("{origin}/index.html?auxiliary=unknown"),
                format!("{origin}/other.html?{query}"),
            ] {
                assert!(!is_allowed_navigation(
                    &tauri::Url::parse(&destination).unwrap(),
                    &main,
                    query
                ));
            }
        }
    }

    #[test]
    fn stale_controls_cannot_start_or_stop_a_replacement_share() {
        for action in [
            ScreenSharingAction::Start,
            ScreenSharingAction::Stop,
            ScreenSharingAction::RetryPointers,
        ] {
            assert!(validate_action(
                &published(),
                &AuxiliaryActionRequest {
                    version: 6,
                    pointer_revision: None,
                    action
                }
            )
            .is_err());
        }
    }

    #[test]
    fn camera_start_does_not_require_desktop_pointers_and_rejects_marker_actions() {
        let mut state = published();
        state.snapshot.source_kind = SharingSourceKind::Camera;
        state.snapshot.pointers_ready = false;
        let request = |action| AuxiliaryActionRequest {
            version: 7,
            pointer_revision: Some("pointer-owner-revision".into()),
            action,
        };
        assert!(validate_action(&state, &request(ScreenSharingAction::Start)).is_ok());
        for action in [
            ScreenSharingAction::ClearAnnotations,
            ScreenSharingAction::RetryPointers,
            ScreenSharingAction::SetPointersEnabled { enabled: true },
        ] {
            assert!(validate_action(&state, &request(action)).is_err());
        }
        state.snapshot.available = false;
        assert!(validate_action(&state, &request(ScreenSharingAction::Start)).is_err());
    }

    #[test]
    fn validates_source_interval_and_availability() {
        let mut state = published();
        let request = |action| AuxiliaryActionRequest {
            version: 7,
            pointer_revision: None,
            action,
        };
        assert!(validate_action(&state, &request(ScreenSharingAction::Start)).is_ok());
        state.snapshot.available = false;
        assert!(validate_action(&state, &request(ScreenSharingAction::Start)).is_err());
        assert!(validate_action(
            &state,
            &request(ScreenSharingAction::SelectSource { source_id: 99 })
        )
        .is_err());
        for interval_seconds in [0, 9, 181, 300, u16::MAX] {
            assert!(validate_action(
                &state,
                &request(ScreenSharingAction::SetInterval { interval_seconds })
            )
            .is_err());
            state.snapshot.interval_seconds = interval_seconds;
            assert!(state.snapshot.validate().is_err());
        }
        for interval_seconds in [10, 20, 30, 60, 179, 180] {
            assert!(validate_action(
                &state,
                &request(ScreenSharingAction::SetInterval { interval_seconds })
            )
            .is_ok());
            state.snapshot.interval_seconds = interval_seconds;
            assert!(state.snapshot.validate().is_ok());
        }
        state.snapshot.active = true;
        assert!(validate_action(
            &state,
            &request(ScreenSharingAction::SelectSource { source_id: 12 })
        )
        .is_err());
        assert!(validate_action(&state, &request(ScreenSharingAction::RefreshSources)).is_err());
        assert!(validate_action(&state, &request(ScreenSharingAction::Stop)).is_ok());
        assert!(validate_action(&state, &request(ScreenSharingAction::ClearAnnotations)).is_ok());
    }

    #[test]
    fn pointer_toggle_is_independent_of_capture_but_rejects_stale_or_unready_controls() {
        let mut state = published();
        state.snapshot.available = false;
        state.snapshot.busy = true;
        let request = |enabled| AuxiliaryActionRequest {
            version: state.version,
            pointer_revision: Some(state.snapshot.pointer_revision.clone()),
            action: ScreenSharingAction::SetPointersEnabled { enabled },
        };
        for enabled in [false, true] {
            assert!(validate_action(&state, &request(enabled)).is_ok());
        }
        let mut stale = request(false);
        stale.version -= 1;
        assert!(validate_action(&state, &stale).is_ok());
        stale.pointer_revision = Some("old-owner-or-setting".into());
        assert!(validate_action(&state, &stale).is_err());
        state.snapshot.pointers_ready = false;
        assert!(validate_action(&state, &request(false)).is_err());
        assert!(
            serde_json::from_value::<ScreenSharingAction>(serde_json::json!({
                "type": "set-pointers-enabled", "enabled": "true"
            }))
            .is_err()
        );
    }

    #[test]
    fn capture_updates_preserve_pointer_actions_but_owner_or_pointer_changes_reject_them() {
        let mut state = published();
        let off = AuxiliaryActionRequest {
            version: state.version,
            pointer_revision: Some(state.snapshot.pointer_revision.clone()),
            action: ScreenSharingAction::SetPointersEnabled { enabled: false },
        };
        state.version += 1;
        state.snapshot.revision = "capture-finished-revision".into();
        state.snapshot.last_observed_at = Some(1000);
        assert!(validate_action(&state, &off).is_ok());
        state.snapshot.pointer_revision = "new-owner-or-pointer-setting".into();
        assert!(validate_action(&state, &off).is_err());
    }
}
