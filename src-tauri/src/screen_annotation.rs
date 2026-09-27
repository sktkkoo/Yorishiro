//! Host-owned references to the explicitly shared display. These marks describe
//! what the resident is talking about; they are not model attention telemetry.
//!
//! Only the main window can grant/revoke a sharing lease. MCP receives opaque
//! frame IDs through the existing image transport, never authority to start
//! capture. All state changes and native drawing run on the AppKit main thread.

use std::collections::VecDeque;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rmcp::schemars;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tokio::sync::watch;

#[cfg(target_os = "macos")]
mod macos;

const FRAME_MAX_AGE: Duration = Duration::from_secs(120);
// Keep only reference metadata, bounded independently of image freshness. Fast
// five-second sampling and speech-triggered captures must not evict an inspected
// image after just a few updates while the agent is preparing its response.
const FRAME_LIMIT: usize = 128;
const DEFAULT_DURATION_MS: u64 = 8_000;
const MAX_DURATION_MS: u64 = 15_000;
// screen_capture::macos::capture bounds its OS callback at 15 seconds. Allow
// that existing capture to finish plus its UI-thread handoff, without forcing
// the model to make a second call merely because capture took a few seconds.
const POINTER_CAPTURE_WAIT: Duration = Duration::from_secs(16);
const POINTER_WAIT_EXPIRED: &str =
    "The screen capture did not finish in time. Inspect a fresh shared image before pointing.";
const FRAME_TOO_OLD: &str = "This shared-screen image is too old. Wait for a fresh shared image.";
const POINTERS_DISABLED: &str =
    "Screen pointers are disabled by the user. Continue discussing the shared image without marks. Do not call or retry pointer tools until the user enables screen pointers.";
#[cfg(not(target_os = "macos"))]
const UNSUPPORTED: &str = "Screen pointers require macOS 14 or later.";

#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct DisplayGeometry {
    pub source_id: u32,
    /// CoreGraphics global logical points, top-left of the main display.
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub pixel_width: usize,
    pub pixel_height: usize,
    pub main_height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) enum AnnotationTarget {
    Arrow {
        x: f64,
        y: f64,
    },
    Rect {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    },
    Ellipse {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    },
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ScreenPointerKind {
    Arrow,
    Rect,
    Ellipse,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScreenPointerRequest {
    /// Opaque frameId supplied with the shared-screen image you inspected.
    pub frame_id: String,
    pub kind: ScreenPointerKind,
    /// Normalized image coordinate: 0 is left, 1 is right. Arrow tip or bounds left.
    pub x: f64,
    /// Normalized image coordinate: 0 is top, 1 is bottom. Arrow tip or bounds top.
    pub y: f64,
    /// Required for rect/ellipse: positive normalized width, contained in the image.
    pub width: Option<f64>,
    /// Required for rect/ellipse: positive normalized height, contained in the image.
    pub height: Option<f64>,
    /// Optional single-line label, at most 80 characters. Plain text only.
    pub label: Option<String>,
    /// Visible lifetime, 500–15000 milliseconds. Defaults to 8000.
    pub duration_ms: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenPointerResult {
    status: &'static str,
    frame_id: String,
    duration_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenPointerSettingsResult {
    enabled: bool,
    pointer_epoch: u64,
}

impl ScreenPointerRequest {
    fn resolve(&self, geometry: DisplayGeometry) -> Result<(AnnotationTarget, u64), String> {
        let unit = |v: f64| v.is_finite() && (0.0..=1.0).contains(&v);
        if !unit(self.x) || !unit(self.y) {
            return Err("x and y must be finite normalized image coordinates from 0 to 1.".into());
        }
        if self
            .label
            .as_ref()
            .is_some_and(|label| label.chars().count() > 80 || label.chars().any(char::is_control))
        {
            return Err("Use a single-line label of at most 80 characters.".into());
        }
        let duration = self.duration_ms.unwrap_or(DEFAULT_DURATION_MS);
        if !(500..=MAX_DURATION_MS).contains(&duration) {
            return Err("durationMs must be between 500 and 15000.".into());
        }
        let x = self.x * geometry.width;
        let y = self.y * geometry.height;
        let target = match self.kind {
            ScreenPointerKind::Arrow => {
                if self.width.is_some() || self.height.is_some() {
                    return Err("An arrow uses only x and y; omit width and height.".into());
                }
                AnnotationTarget::Arrow { x, y }
            }
            ScreenPointerKind::Rect | ScreenPointerKind::Ellipse => {
                let (Some(width), Some(height)) = (self.width, self.height) else {
                    return Err("A rect or ellipse requires width and height.".into());
                };
                if !unit(width)
                    || !unit(height)
                    || width <= 0.0
                    || height <= 0.0
                    || self.x + width > 1.0 + f64::EPSILON
                    || self.y + height > 1.0 + f64::EPSILON
                {
                    return Err(
                        "The shape must have positive dimensions and fit inside the image.".into(),
                    );
                }
                let width = width * geometry.width;
                let height = height * geometry.height;
                match self.kind {
                    ScreenPointerKind::Ellipse => AnnotationTarget::Ellipse {
                        x,
                        y,
                        width,
                        height,
                    },
                    _ => AnnotationTarget::Rect {
                        x,
                        y,
                        width,
                        height,
                    },
                }
            }
        };
        Ok((target, duration))
    }
}

#[derive(Clone)]
struct FrameAnchor {
    id: String,
    fingerprint: u64,
    width: usize,
    height: usize,
    observed_at: Instant,
}

struct SharingLease {
    id: String,
    geometry: DisplayGeometry,
    frames: VecDeque<FrameAnchor>,
    capturing: bool,
    selection: crate::screen_capture::ScreenCaptureSelection,
}

#[derive(Clone)]
struct VisibleAnnotation {
    generation: u64,
    geometry: DisplayGeometry,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    target: AnnotationTarget,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    label: Option<String>,
    expires_at: Instant,
}

struct AnnotationState {
    document_id: String,
    pointers_enabled: bool,
    setting_revision: u64,
    pointer_epoch: u64,
    lease: Option<SharingLease>,
    // One accepted reference survives cache eviction while capture completes.
    pending_frame: Option<FrameAnchor>,
    active_capture: Option<String>,
    visible: Option<VisibleAnnotation>,
    generation: u64,
    changes: watch::Sender<u64>,
}

impl Default for AnnotationState {
    fn default() -> Self {
        Self {
            document_id: uuid::Uuid::new_v4().to_string(),
            pointers_enabled: true,
            setting_revision: 0,
            pointer_epoch: 0,
            lease: None,
            pending_frame: None,
            active_capture: None,
            visible: None,
            generation: 0,
            changes: watch::channel(0).0,
        }
    }
}

impl AnnotationState {
    fn begin_for_document(
        &mut self,
        document_id: &str,
        id: String,
        geometry: DisplayGeometry,
    ) -> Result<(), String> {
        if self.document_id != document_id {
            return Err(
                "The application reloaded. Start screen sharing from the current window.".into(),
            );
        }
        self.begin(id, geometry);
        Ok(())
    }

    fn reload(&mut self) {
        self.document_id = uuid::Uuid::new_v4().to_string();
        self.setting_revision = 0;
        self.lease = None;
        self.clear();
    }

    fn set_enabled(
        &mut self,
        document_id: &str,
        revision: u64,
        enabled: bool,
    ) -> Result<bool, String> {
        if document_id != self.document_id {
            return Err(
                "The application reloaded. Change screen pointers from the current window.".into(),
            );
        }
        if revision <= self.setting_revision {
            return Err("This screen pointer setting update was superseded.".into());
        }
        // A newer ON can reach native before the intervening OFF. Even when
        // the final value matches, a skipped revision must revoke old marks.
        let skipped_update = revision - self.setting_revision > 1;
        self.setting_revision = revision;
        if self.pointers_enabled == enabled && !skipped_update {
            return Ok(false);
        }
        self.pointers_enabled = enabled;
        self.pointer_epoch = self.pointer_epoch.wrapping_add(1);
        // The display remains shared. Both edges revoke all previous image
        // references, including fingerprint reuse, so re-enabling never grants
        // old or delayed pointer calls authority to draw again.
        if let Some(lease) = self.lease.as_mut() {
            lease.frames.clear();
        }
        self.clear();
        Ok(true)
    }

    fn begin(&mut self, id: String, geometry: DisplayGeometry) {
        self.clear();
        self.lease = Some(SharingLease {
            id,
            geometry,
            frames: VecDeque::new(),
            capturing: false,
            selection: Default::default(),
        });
    }

    fn clear(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.pending_frame = None;
        self.visible = None;
        self.changed();
    }

    fn changed(&self) {
        self.changes
            .send_modify(|revision| *revision = revision.wrapping_add(1));
    }

    fn expire_visible(&mut self, generation: u64) {
        if self
            .visible
            .as_ref()
            .is_some_and(|mark| mark.generation == generation)
        {
            self.visible = None;
            // Natural expiry of an older mark must not cancel a newer request
            // waiting for capture. User clear/stop always advance generation.
            if self.generation == generation {
                self.generation = self.generation.wrapping_add(1);
                self.pending_frame = None;
            }
            self.changed();
        }
    }

    fn finish_capture(&mut self, share_id: &str) -> bool {
        if self.active_capture.as_deref() == Some(share_id) {
            self.active_capture = None;
            self.changed();
        }
        let Some(lease) = self.lease.as_mut().filter(|lease| lease.id == share_id) else {
            return false;
        };
        lease.capturing = false;
        self.changed();
        true
    }

    fn end(&mut self, id: &str) -> bool {
        if self.lease.as_ref().is_some_and(|lease| lease.id == id) {
            self.lease = None;
            self.clear();
            true
        } else {
            false
        }
    }

    fn lease(&mut self, id: &str, geometry: DisplayGeometry) -> Result<&mut SharingLease, String> {
        let current = self.lease.as_ref().ok_or("Screen sharing is stopped.")?;
        if current.id != id {
            return Err("This screen sharing lease has ended.".into());
        }
        if current.geometry != geometry {
            self.end(id);
            return Err("The shared display changed. Start sharing again before pointing.".into());
        }
        self.lease
            .as_mut()
            .ok_or_else(|| "Screen sharing is stopped.".into())
    }

    fn register(
        &mut self,
        id: &str,
        geometry: DisplayGeometry,
        fingerprint: u64,
        dimensions: (usize, usize),
        capture_epoch: u64,
        now: Instant,
    ) -> Result<String, String> {
        let current_epoch = self.pointer_epoch;
        let lease = self.lease(id, geometry)?;
        if capture_epoch != current_epoch || !lease.selection.supports_pointers() {
            // Sharing continues through a pointer toggle. Deliver the pixels,
            // but do not mint pointer authority from a pre-toggle capture.
            return Ok(uuid::Uuid::new_v4().to_string());
        }
        let (width, height) = dimensions;
        lease
            .frames
            .retain(|frame| now.duration_since(frame.observed_at) <= FRAME_MAX_AGE);
        // Identical captures are deduplicated by the frontend. Keep the token of
        // that actual delivered image valid while the same pixels are observed.
        if let Some(index) = lease.frames.iter().position(|frame| {
            frame.fingerprint == fingerprint && frame.width == width && frame.height == height
        }) {
            let mut frame = lease.frames.remove(index).expect("existing frame index");
            frame.observed_at = now;
            let frame_id = frame.id.clone();
            lease.frames.push_back(frame);
            if let Some(pending) = self
                .pending_frame
                .as_mut()
                .filter(|pending| pending.id == frame_id)
            {
                pending.observed_at = now;
            }
            return Ok(frame_id);
        }
        let frame_id = uuid::Uuid::new_v4().to_string();
        lease.frames.push_back(FrameAnchor {
            id: frame_id.clone(),
            fingerprint,
            width,
            height,
            observed_at: now,
        });
        while lease.frames.len() > FRAME_LIMIT {
            lease.frames.pop_front();
        }
        Ok(frame_id)
    }

    fn frame_geometry(&self, id: &str, now: Instant) -> Result<DisplayGeometry, String> {
        if !self.pointers_enabled {
            return Err(POINTERS_DISABLED.into());
        }
        let lease = self
            .lease
            .as_ref()
            .ok_or("Screen sharing is stopped. Ask the user to start sharing.")?;
        let frame = lease.frames.iter().find(|frame| frame.id == id).ok_or(
            "This frame is no longer available. Inspect a recent shared-screen image first.",
        )?;
        if now.duration_since(frame.observed_at) > FRAME_MAX_AGE {
            return Err(FRAME_TOO_OLD.into());
        }
        Ok(lease.geometry)
    }

    fn reserve_show(
        &mut self,
        request: Arc<ScreenPointerRequest>,
        now: Instant,
    ) -> Result<PendingShow, String> {
        let geometry = self.frame_geometry(&request.frame_id, now)?;
        request.resolve(geometry)?;
        let lease = self.lease.as_ref().ok_or("Screen sharing is stopped.")?;
        let share_id = lease.id.clone();
        let frame = lease
            .frames
            .iter()
            .find(|frame| frame.id == request.frame_id)
            .expect("frame was validated without releasing the state lock")
            .clone();
        self.generation = self.generation.wrapping_add(1);
        self.pending_frame = Some(frame);
        self.changed();
        Ok(PendingShow {
            request,
            share_id,
            document_id: self.document_id.clone(),
            geometry,
            generation: self.generation,
        })
    }

    fn pending_geometry(
        &self,
        pending: &PendingShow,
        now: Instant,
    ) -> Result<(DisplayGeometry, bool), String> {
        if !self.pointers_enabled {
            return Err(POINTERS_DISABLED.into());
        }
        if self.document_id != pending.document_id || self.generation != pending.generation {
            return Err("This pointer request was cleared or superseded.".into());
        }
        let lease = self
            .lease
            .as_ref()
            .filter(|lease| lease.id == pending.share_id)
            .ok_or("This screen sharing lease has ended.")?;
        // Capacity eviction must not cancel an already accepted show during
        // capture. Only a fresh observation of this exact ID may renew its age;
        // never borrow the latest image's timestamp or replace the request ID.
        let frame = self
            .pending_frame
            .as_ref()
            .filter(|frame| frame.id == pending.request.frame_id)
            .ok_or("This pointer request was cleared or superseded.")?;
        if now.duration_since(frame.observed_at) > FRAME_MAX_AGE {
            return Err(FRAME_TOO_OLD.into());
        }
        let geometry = lease.geometry;
        if geometry != pending.geometry {
            return Err("The shared display changed. Start sharing again before pointing.".into());
        }
        Ok((geometry, lease.capturing || self.active_capture.is_some()))
    }

    fn should_hide(
        &self,
        generation: u64,
        now: Instant,
        geometry: Option<DisplayGeometry>,
    ) -> bool {
        self.visible.as_ref().is_some_and(|mark| {
            mark.generation == generation
                && (now >= mark.expires_at || geometry != Some(mark.geometry))
        })
    }
}

#[derive(Clone)]
struct PendingShow {
    request: Arc<ScreenPointerRequest>,
    share_id: String,
    document_id: String,
    geometry: DisplayGeometry,
    generation: u64,
}

struct ShowLifetime {
    cancelled: AtomicBool,
    deadline: Instant,
}

impl ShowLifetime {
    fn check(&self, now: Instant) -> Result<(), String> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err("The screen pointer request was cancelled.".into());
        }
        if now >= self.deadline {
            return Err(POINTER_WAIT_EXPIRED.into());
        }
        Ok(())
    }
}

struct CancelShowOnDrop(Arc<ShowLifetime>);

impl Drop for CancelShowOnDrop {
    fn drop(&mut self) {
        self.0.cancelled.store(true, Ordering::Release);
    }
}

#[derive(Default)]
pub struct ScreenAnnotationState(Mutex<AnnotationState>);

fn require_host(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Only the main application window controls screen sharing.".into())
    }
}

async fn on_main<R: Send + 'static>(
    app: &AppHandle,
    action: impl FnOnce(&AppHandle) -> Result<R, String> + Send + 'static,
) -> Result<R, String> {
    let handle = app.clone();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = sender.send(action(&handle));
    })
    .map_err(|_| "Could not update the screen pointer.".to_string())?;
    receiver
        .await
        .map_err(|_| "Screen pointer update was cancelled.".to_string())?
}

fn display_geometry(source_id: u32) -> Result<DisplayGeometry, String> {
    #[cfg(target_os = "macos")]
    return macos::display_geometry(source_id);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = source_id;
        Err(UNSUPPORTED.into())
    }
}

fn hide() {
    #[cfg(target_os = "macos")]
    macos::hide();
}

fn draw(mark: &VisibleAnnotation) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return macos::show(mark.geometry, mark.target, mark.label.as_deref());
    #[cfg(not(target_os = "macos"))]
    {
        let _ = mark;
        Err(UNSUPPORTED.into())
    }
}

pub(crate) fn window_id() -> Option<u32> {
    #[cfg(target_os = "macos")]
    return macos::window_id();
    #[cfg(not(target_os = "macos"))]
    None
}

#[tauri::command]
pub fn screen_annotation_document(window: tauri::WebviewWindow) -> Result<String, String> {
    require_host(&window)?;
    current_document(window.app_handle())
}

/// 同じメイン WebView の有効期間を画像共有にも適用する。
pub(crate) fn current_document(app: &AppHandle) -> Result<String, String> {
    let managed = app.state::<ScreenAnnotationState>();
    let state = managed
        .0
        .lock()
        .map_err(|_| "Screen pointer state is unavailable.")?;
    Ok(state.document_id.clone())
}

/// A user setting, independent of the sharing lease. Only the current main
/// document can change it; request ordering survives rapid toggles/remounts.
#[tauri::command]
pub async fn screen_annotation_set_enabled(
    window: tauri::WebviewWindow,
    document_id: String,
    revision: u64,
    enabled: bool,
) -> Result<ScreenPointerSettingsResult, String> {
    require_host(&window)?;
    on_main(window.app_handle(), move |app| {
        let managed = app.state::<ScreenAnnotationState>();
        let mut state = managed
            .0
            .lock()
            .map_err(|_| "Screen pointer state is unavailable.")?;
        if state.set_enabled(&document_id, revision, enabled)? || !state.pointers_enabled {
            hide();
        }
        Ok(ScreenPointerSettingsResult {
            enabled: state.pointers_enabled,
            pointer_epoch: state.pointer_epoch,
        })
    })
    .await
}

/// Page reload destroys the JS owner without destroying the native main window.
/// Rotate its authority synchronously so an old, queued begin cannot re-grant it.
pub fn document_reloaded(app: &AppHandle) {
    crate::screen_capture::region_frame_document_reloaded(app);
    if let Some(managed) = app.try_state::<ScreenAnnotationState>() {
        if let Ok(mut state) = managed.0.lock() {
            state.reload();
        }
    }
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(managed) = handle.try_state::<ScreenAnnotationState>() {
            if let Ok(state) = managed.0.lock() {
                // Do not erase a new mark if this UI-thread callback was delayed.
                if state.visible.is_none() {
                    hide();
                }
            }
        }
    });
}

#[tauri::command]
pub async fn screen_annotation_begin(
    window: tauri::WebviewWindow,
    share_id: String,
    source_id: u32,
    document_id: String,
    selection: Option<crate::screen_capture::ScreenCaptureSelection>,
) -> Result<(), String> {
    require_host(&window)?;
    let selection = selection.unwrap_or_default();
    selection.validate()?;
    if uuid::Uuid::parse_str(&share_id).is_err() {
        return Err("Invalid screen sharing lease.".into());
    }
    on_main(window.app_handle(), move |app| {
        let geometry = selection_geometry(source_id, &selection)?;
        let managed = app.state::<ScreenAnnotationState>();
        let mut state = managed
            .0
            .lock()
            .map_err(|_| "Screen pointer state is unavailable.")?;
        state.begin_for_document(&document_id, share_id, geometry)?;
        if let Some(lease) = state.lease.as_mut() {
            lease.selection = selection;
        }
        hide();
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn screen_annotation_end(
    window: tauri::WebviewWindow,
    share_id: String,
) -> Result<(), String> {
    require_host(&window)?;
    on_main(window.app_handle(), move |app| {
        let managed = app.state::<ScreenAnnotationState>();
        let mut state = managed
            .0
            .lock()
            .map_err(|_| "Screen pointer state is unavailable.")?;
        if state.end(&share_id) {
            hide();
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn screen_annotation_clear(window: tauri::WebviewWindow) -> Result<(), String> {
    require_host(&window)?;
    clear(window.app_handle()).await
}

pub async fn clear(app: &AppHandle) -> Result<(), String> {
    on_main(app, move |app| {
        let managed = app.state::<ScreenAnnotationState>();
        let mut state = managed
            .0
            .lock()
            .map_err(|_| "Screen pointer state is unavailable.")?;
        state.clear();
        hide();
        Ok(())
    })
    .await
}

/// Called from the application's main-thread window/exit event handlers.
pub fn shutdown(app: &AppHandle) {
    crate::screen_capture::shutdown_region_frame();
    let managed = app.state::<ScreenAnnotationState>();
    if let Ok(mut state) = managed.0.lock() {
        state.lease = None;
        state.clear();
    }
    hide();
}

pub async fn show(
    app: &AppHandle,
    request: ScreenPointerRequest,
) -> Result<ScreenPointerResult, String> {
    let lifetime = Arc::new(ShowLifetime {
        cancelled: AtomicBool::new(false),
        deadline: Instant::now() + POINTER_CAPTURE_WAIT,
    });
    // Dropping this future (including timeout) also disarms a callback that was
    // already queued on the UI thread. It cannot draw a late, abandoned request.
    let _cancel = CancelShowOnDrop(lifetime.clone());
    let deadline = tokio::time::Instant::from_std(lifetime.deadline);
    let work = async {
        let initial_lifetime = lifetime.clone();
        let (pending, mut changes, shown) = on_main(app, move |app| {
            initial_lifetime.check(Instant::now())?;
            let managed = app.state::<ScreenAnnotationState>();
            let mut state = managed
                .0
                .lock()
                .map_err(|_| "Screen pointer state is unavailable.")?;
            let pending = state.reserve_show(Arc::new(request), Instant::now())?;
            // Subscribe while holding the same lock as the capture check, so a
            // completion before the async waiter starts cannot be missed.
            let changes = state.changes.subscribe();
            let shown = try_show(app, &mut state, &pending, &initial_lifetime)?;
            Ok((pending, changes, shown))
        })
        .await?;
        if let Some(result) = shown {
            return Ok(result);
        }
        loop {
            // Wait in Tokio, never in AppKit and never with the state locked.
            changes
                .changed()
                .await
                .map_err(|_| "Screen pointer state was closed.".to_string())?;
            let next = pending.clone();
            let next_lifetime = lifetime.clone();
            let shown = on_main(app, move |app| {
                let managed = app.state::<ScreenAnnotationState>();
                let mut state = managed
                    .0
                    .lock()
                    .map_err(|_| "Screen pointer state is unavailable.")?;
                try_show(app, &mut state, &next, &next_lifetime)
            })
            .await?;
            if let Some(result) = shown {
                return Ok(result);
            }
        }
    };
    tokio::time::timeout_at(deadline, work)
        .await
        .map_err(|_| POINTER_WAIT_EXPIRED.to_string())?
}

fn try_show(
    app: &AppHandle,
    state: &mut AnnotationState,
    pending: &PendingShow,
    lifetime: &ShowLifetime,
) -> Result<Option<ScreenPointerResult>, String> {
    let now = Instant::now();
    lifetime.check(now)?;
    let (geometry, capturing) = state.pending_geometry(pending, now)?;
    if display_geometry(geometry.source_id).ok() != Some(geometry) {
        state.lease = None;
        state.clear();
        hide();
        return Err("The shared display changed. Start sharing again before pointing.".into());
    }
    if capturing {
        return Ok(None);
    }
    let (target, duration_ms) = pending.request.resolve(geometry)?;
    lifetime.check(Instant::now())?;
    let mark = VisibleAnnotation {
        generation: pending.generation,
        geometry,
        target,
        label: pending.request.label.clone(),
        // The requested visible lifetime starts when the mark can be drawn,
        // rather than being consumed while a capture is still in flight.
        expires_at: Instant::now() + Duration::from_millis(duration_ms),
    };
    draw(&mark)?;
    state.pending_frame = None;
    state.visible = Some(mark);
    // Start cleanup from the UI action, even if the MCP caller disconnects
    // immediately after drawing and never receives its result.
    start_watchdog(app, pending.generation);
    Ok(Some(ScreenPointerResult {
        status: "shown",
        frame_id: pending.request.frame_id.clone(),
        duration_ms,
    }))
}

fn start_watchdog(app: &AppHandle, generation: u64) {
    let handle = app.clone();
    // Each replacement invalidates the old watchdog, so its expiry cannot hide
    // a newer mark. Also clear within 250 ms of disconnect/reconfiguration.
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(250)).await;
            let keep = on_main(&handle, move |app| {
                let managed = app.state::<ScreenAnnotationState>();
                let mut state = managed
                    .0
                    .lock()
                    .map_err(|_| "Screen pointer state is unavailable.")?;
                let Some(mark) = state.visible.as_ref() else {
                    return Ok(false);
                };
                if mark.generation != generation {
                    return Ok(false);
                }
                let geometry = display_geometry(mark.geometry.source_id).ok();
                if state.should_hide(generation, Instant::now(), geometry) {
                    if geometry != state.lease.as_ref().map(|lease| lease.geometry) {
                        state.lease = None;
                        state.clear();
                    } else {
                        state.expire_visible(generation);
                    }
                    hide();
                    return Ok(false);
                }
                Ok(true)
            })
            .await;
            if keep != Ok(true) {
                break;
            }
        }
    });
}

/// Restricted captures carry no desktop pointer geometry. Window IDs are an
/// independent namespace; never pass them through a display lookup or fallback.
fn selection_geometry(
    source_id: u32,
    selection: &crate::screen_capture::ScreenCaptureSelection,
) -> Result<DisplayGeometry, String> {
    match selection {
        crate::screen_capture::ScreenCaptureSelection::Window => Ok(DisplayGeometry {
            source_id,
            x: 0.0,
            y: 0.0,
            width: 1.0,
            height: 1.0,
            pixel_width: 1,
            pixel_height: 1,
            main_height: 1.0,
        }),
        crate::screen_capture::ScreenCaptureSelection::Region { region } => {
            let geometry = display_geometry(source_id)?;
            region.validate_display(geometry.width, geometry.height)?;
            Ok(geometry)
        }
        crate::screen_capture::ScreenCaptureSelection::Display => display_geometry(source_id),
    }
}

/// Keep existing marks visible while excluding their pinned window from capture.
/// New show requests wait until capture completes so its filter stays valid.
pub struct CaptureGuard {
    pub(crate) selection: crate::screen_capture::ScreenCaptureSelection,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub(crate) excluded_window: Option<u32>,
    app: AppHandle,
    share_id: String,
    geometry: DisplayGeometry,
    pointer_epoch: u64,
}

pub(crate) struct FrameReference {
    pub frame_id: String,
    pub pointers_enabled: bool,
    pub pointer_frame_valid: bool,
    pub pointer_epoch: u64,
}

impl Drop for CaptureGuard {
    fn drop(&mut self) {
        let app = self.app.clone();
        let share_id = self.share_id.clone();
        let _ = self.app.run_on_main_thread(move || {
            let managed = app.state::<ScreenAnnotationState>();
            let Ok(mut state) = managed.0.lock() else {
                return;
            };
            state.finish_capture(&share_id);
        });
    }
}

pub async fn begin_capture(
    app: &AppHandle,
    share_id: String,
    source_id: u32,
) -> Result<CaptureGuard, String> {
    let id = share_id.clone();
    let (geometry, pointer_epoch, excluded_window, selection) = on_main(app, move |app| {
        let managed = app.state::<ScreenAnnotationState>();
        let mut state = managed
            .0
            .lock()
            .map_err(|_| "Screen pointer state is unavailable.")?;
        let selection = state
            .lease
            .as_ref()
            .filter(|lease| lease.id == id)
            .ok_or("This screen sharing lease has ended.")?
            .selection
            .clone();
        let geometry = selection_geometry(source_id, &selection)?;
        if state.active_capture.is_some() {
            return Err("A screen capture is already in progress.".into());
        }
        let lease = match state.lease(&id, geometry) {
            Ok(lease) => lease,
            Err(error) => {
                if state.lease.is_none() {
                    hide();
                }
                return Err(error);
            }
        };
        if lease.capturing {
            return Err("A screen capture is already in progress.".into());
        }
        lease.capturing = true;
        let excluded_window = if state.visible.is_some() {
            window_id()
        } else {
            None
        };
        state.active_capture = Some(id.clone());
        state.changed();
        Ok((geometry, state.pointer_epoch, excluded_window, selection))
    })
    .await?;
    Ok(CaptureGuard {
        selection,
        excluded_window,
        app: app.clone(),
        share_id,
        geometry,
        pointer_epoch,
    })
}

pub(crate) async fn register_frame(
    guard: &CaptureGuard,
    frame: &crate::screen_capture::ScreenCaptureFrame,
) -> Result<FrameReference, String> {
    if frame.source_id != guard.geometry.source_id || frame.width == 0 || frame.height == 0 {
        return Err("Screen capture does not match the shared display.".into());
    }
    if guard.selection.supports_pointers()
        && (frame.width, frame.height)
            != crate::screen_capture::bounded_dimensions(
                guard.geometry.pixel_width,
                guard.geometry.pixel_height,
            )?
    {
        return Err("Screen capture dimensions changed. Start sharing again.".into());
    }
    let mut hasher = DefaultHasher::new();
    frame.data_url.hash(&mut hasher);
    let fingerprint = hasher.finish();
    let width = frame.width;
    let height = frame.height;
    let id = guard.share_id.clone();
    let geometry = guard.geometry;
    let pointer_epoch = guard.pointer_epoch;
    let selection = guard.selection.clone();
    on_main(&guard.app, move |app| {
        let managed = app.state::<ScreenAnnotationState>();
        let mut state = managed
            .0
            .lock()
            .map_err(|_| "Screen pointer state is unavailable.")?;
        if selection_geometry(geometry.source_id, &selection).ok() != Some(geometry) {
            if state.end(&id) {
                hide();
            }
            return Err("The display changed while capturing. Start sharing again.".into());
        }
        if state.lease(&id, geometry)?.selection != selection {
            return Err("The selected capture source changed. Start sharing again.".into());
        }
        let frame_id = state.register(
            &id,
            geometry,
            fingerprint,
            (width, height),
            pointer_epoch,
            Instant::now(),
        )?;
        Ok(FrameReference {
            frame_id,
            pointers_enabled: state.pointers_enabled && selection.supports_pointers(),
            pointer_frame_valid: pointer_epoch == state.pointer_epoch
                && selection.supports_pointers(),
            pointer_epoch,
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn geometry() -> DisplayGeometry {
        DisplayGeometry {
            source_id: 1,
            x: -1920.0,
            y: -120.0,
            width: 1920.0,
            height: 1080.0,
            pixel_width: 3840,
            pixel_height: 2160,
            main_height: 900.0,
        }
    }

    fn request(kind: ScreenPointerKind, x: f64, y: f64) -> ScreenPointerRequest {
        ScreenPointerRequest {
            frame_id: "frame".into(),
            kind,
            x,
            y,
            width: None,
            height: None,
            label: None,
            duration_ms: None,
        }
    }

    #[test]
    fn restricted_leases_never_register_display_pointer_anchors() {
        let mut state = AnnotationState::default();
        let now = Instant::now();
        for selection in [
            crate::screen_capture::ScreenCaptureSelection::Window,
            crate::screen_capture::ScreenCaptureSelection::Region {
                region: crate::screen_capture::ScreenCaptureRegion {
                    x: 20.0,
                    y: 30.0,
                    width: 100.0,
                    height: 80.0,
                    display_width: 1440.0,
                    display_height: 900.0,
                },
            },
        ] {
            state.begin("restricted".into(), geometry());
            state.lease.as_mut().unwrap().selection = selection;
            let frame = state
                .register(
                    "restricted",
                    geometry(),
                    1,
                    (200, 160),
                    state.pointer_epoch,
                    now,
                )
                .unwrap();
            assert!(state.lease.as_ref().unwrap().frames.is_empty());
            assert!(state.frame_geometry(&frame, now).is_err());
        }
    }

    #[test]
    fn normalized_image_coordinates_map_to_retina_display_points_not_global_or_image_pixels() {
        let g = geometry();
        assert_eq!(
            request(ScreenPointerKind::Arrow, 0.25, 0.75)
                .resolve(g)
                .unwrap()
                .0,
            AnnotationTarget::Arrow { x: 480.0, y: 810.0 }
        );
        let mut rect = request(ScreenPointerKind::Rect, 0.75, 0.5);
        rect.width = Some(0.25);
        rect.height = Some(0.5);
        assert_eq!(
            rect.resolve(g).unwrap().0,
            AnnotationTarget::Rect {
                x: 1440.0,
                y: 540.0,
                width: 480.0,
                height: 540.0
            }
        );
        rect.kind = ScreenPointerKind::Ellipse;
        assert_eq!(
            rect.resolve(g).unwrap().0,
            AnnotationTarget::Ellipse {
                x: 1440.0,
                y: 540.0,
                width: 480.0,
                height: 540.0
            }
        );
        let portrait = DisplayGeometry {
            width: 900.0,
            height: 1600.0,
            ..g
        };
        assert_eq!(
            request(ScreenPointerKind::Arrow, 1.0, 0.0)
                .resolve(portrait)
                .unwrap()
                .0,
            AnnotationTarget::Arrow { x: 900.0, y: 0.0 }
        );
    }

    #[test]
    fn malformed_coordinates_labels_and_unbounded_lifetimes_are_rejected() {
        for x in [f64::NAN, f64::INFINITY, -0.1, 1.1] {
            assert!(request(ScreenPointerKind::Arrow, x, 0.5)
                .resolve(geometry())
                .is_err());
        }
        let mut rect = request(ScreenPointerKind::Rect, 0.8, 0.5);
        assert!(rect.resolve(geometry()).is_err());
        rect.width = Some(0.3);
        rect.height = Some(0.2);
        assert!(rect.resolve(geometry()).is_err());
        rect.width = Some(0.0);
        assert!(rect.resolve(geometry()).is_err());
        let mut arrow = request(ScreenPointerKind::Arrow, 0.5, 0.5);
        arrow.duration_ms = Some(15_001);
        assert!(arrow.resolve(geometry()).is_err());
        arrow.duration_ms = None;
        arrow.label = Some("two\nlines".into());
        assert!(arrow.resolve(geometry()).is_err());
    }

    #[test]
    fn ellipse_uses_the_same_normalized_bounds_as_rect_on_retina_and_portrait_displays() {
        let mut ellipse = request(ScreenPointerKind::Ellipse, 0.75, 0.5);
        ellipse.width = Some(0.25);
        ellipse.height = Some(0.5);
        assert_eq!(
            ellipse.resolve(geometry()).unwrap().0,
            AnnotationTarget::Ellipse {
                x: 1440.0,
                y: 540.0,
                width: 480.0,
                height: 540.0
            }
        );
        let portrait = DisplayGeometry {
            width: 900.0,
            height: 1600.0,
            ..geometry()
        };
        assert_eq!(
            ellipse.resolve(portrait).unwrap().0,
            AnnotationTarget::Ellipse {
                x: 675.0,
                y: 800.0,
                width: 225.0,
                height: 800.0
            }
        );
        let from_json: ScreenPointerRequest = serde_json::from_str(
            r#"{"frameId":"frame","kind":"ellipse","x":0.75,"y":0.5,"width":0.25,"height":0.5}"#,
        )
        .unwrap();
        assert_eq!(
            from_json.resolve(geometry()).unwrap().0,
            ellipse.resolve(geometry()).unwrap().0
        );
    }

    #[test]
    fn rectangle_and_ellipse_share_strict_bounding_box_validation() {
        for kind in [ScreenPointerKind::Rect, ScreenPointerKind::Ellipse] {
            let mut shape = request(kind, 0.25, 0.5);
            assert!(shape.resolve(geometry()).is_err());
            shape.width = Some(0.75);
            shape.height = Some(0.5);
            assert!(shape.resolve(geometry()).is_ok());
            for dimension in [f64::NAN, f64::INFINITY, -0.1, 0.0, 0.76] {
                shape.width = Some(dimension);
                assert!(shape.resolve(geometry()).is_err());
            }
            shape.width = Some(0.75);
            for dimension in [f64::NAN, f64::INFINITY, -0.1, 0.0, 0.51] {
                shape.height = Some(dimension);
                assert!(shape.resolve(geometry()).is_err());
            }
        }
        let schema = serde_json::to_string(&schemars::schema_for!(ScreenPointerRequest)).unwrap();
        for kind in ["arrow", "rect", "ellipse"] {
            assert!(schema.contains(kind));
        }
        let mut json = serde_json::json!({
            "frameId": "frame", "kind": "ellipse", "x": 0.1, "y": 0.2,
            "width": 0.3, "height": 0.4
        });
        assert!(serde_json::from_value::<ScreenPointerRequest>(json.clone()).is_ok());
        json["strokeColor"] = serde_json::json!("red");
        assert!(serde_json::from_value::<ScreenPointerRequest>(json).is_err());
    }

    #[test]
    fn reenable_requires_a_new_capture_and_never_revives_pre_toggle_work() {
        let now = Instant::now();
        let (mut state, pending) = waiting_pointer(now);
        let document = state.document_id.clone();
        let original_epoch = state.pointer_epoch;
        state.set_enabled(&document, 1, false).unwrap();
        let disabled_epoch = state.pointer_epoch;
        let disabled_frame = state
            .register("lease", geometry(), 1, (2560, 1440), disabled_epoch, now)
            .unwrap();
        // Identical shared images still deduplicate while pointers are OFF.
        assert_eq!(
            state
                .register("lease", geometry(), 1, (2560, 1440), disabled_epoch, now)
                .unwrap(),
            disabled_frame
        );
        state.set_enabled(&document, 2, true).unwrap();
        assert!(state.visible.is_none());
        assert!(state.pending_geometry(&pending, now).is_err());
        assert!(state
            .frame_geometry(&pending.request.frame_id, now)
            .is_err());
        assert!(state.frame_geometry(&disabled_frame, now).is_err());
        for epoch in [original_epoch, disabled_epoch] {
            let late_frame = state
                .register("lease", geometry(), 1, (2560, 1440), epoch, now)
                .unwrap();
            assert!(state.frame_geometry(&late_frame, now).is_err());
        }
        assert!(state.lease.as_ref().unwrap().frames.is_empty());
        let fresh_epoch = state.pointer_epoch;
        let fresh = state
            .register("lease", geometry(), 1, (2560, 1440), fresh_epoch, now)
            .unwrap();
        assert_ne!(fresh, pending.request.frame_id);
        assert_ne!(fresh, disabled_frame);
        assert!(state.frame_geometry(&fresh, now).is_ok());
        let mut next = request(ScreenPointerKind::Arrow, 0.5, 0.5);
        next.frame_id = fresh;
        assert!(state.reserve_show(Arc::new(next), now).is_ok());
        assert!(state.visible.is_none());
    }

    #[test]
    fn setting_updates_are_document_fenced_and_ordered_across_reloads() {
        let mut state = AnnotationState::default();
        let document = state.document_id.clone();
        assert!(state.set_enabled(&document, 0, false).is_err());
        state.set_enabled(&document, 2, false).unwrap();
        assert!(state.set_enabled(&document, 1, true).is_err());
        assert!(!state.pointers_enabled);
        state.set_enabled(&document, 4, true).unwrap();
        assert!(state.set_enabled(&document, 3, false).is_err());
        assert!(state.pointers_enabled);
        state.set_enabled(&document, 5, false).unwrap();
        state.reload();
        assert!(!state.pointers_enabled);
        assert!(state.set_enabled(&document, 100, true).is_err());
        let current_document = state.document_id.clone();
        assert!(!state.set_enabled(&current_document, 1, false).unwrap());
        state
            .begin_for_document(&current_document, "new".into(), geometry())
            .unwrap();
        assert!(!state.pointers_enabled);
    }

    #[test]
    fn reapplying_the_current_setting_preserves_existing_frame_authority() {
        let now = Instant::now();
        let (mut state, pending) = waiting_pointer(now);
        let document = state.document_id.clone();
        let changes = state.changes.subscribe();
        assert!(!state.set_enabled(&document, 1, true).unwrap());
        assert!(state.pending_geometry(&pending, now).is_ok());
        assert!(!changes.has_changed().unwrap());
    }

    #[test]
    fn stop_and_source_change_revoke_old_tokens_and_late_stops_preserve_new_lease() {
        let now = Instant::now();
        let mut state = AnnotationState::default();
        state.begin("first".into(), geometry());
        let frame = state
            .register("first", geometry(), 1, (2560, 1440), 0, now)
            .unwrap();
        assert!(state.frame_geometry(&frame, now).is_ok());
        state.end("first");
        assert!(state.frame_geometry(&frame, now).is_err());
        state.begin("second".into(), geometry());
        assert!(!state.end("first"));
        assert!(state
            .register("first", geometry(), 2, (2560, 1440), 0, now)
            .is_err());
        let next = state
            .register("second", geometry(), 3, (2560, 1440), 0, now)
            .unwrap();
        assert!(state.frame_geometry(&next, now).is_ok());
        let moved = DisplayGeometry {
            x: 0.0,
            ..geometry()
        };
        assert!(state
            .register("second", moved, 3, (2560, 1440), 0, now)
            .is_err());
        assert!(state.frame_geometry(&next, now).is_err());
    }

    #[test]
    fn document_reload_revokes_frames_and_rejects_a_late_old_begin() {
        let now = Instant::now();
        let mut state = AnnotationState::default();
        let old_document = state.document_id.clone();
        state
            .begin_for_document(&old_document, "old".into(), geometry())
            .unwrap();
        let frame = state
            .register("old", geometry(), 1, (2560, 1440), 0, now)
            .unwrap();
        state.reload();
        assert!(state.frame_geometry(&frame, now).is_err());
        assert!(state
            .begin_for_document(&old_document, "late".into(), geometry())
            .is_err());
        let current_document = state.document_id.clone();
        state
            .begin_for_document(&current_document, "current".into(), geometry())
            .unwrap();
        assert!(!state.end("old"));
        assert_eq!(state.lease.as_ref().unwrap().id, "current");
    }

    #[test]
    fn unchanged_pixels_keep_delivered_token_valid_without_retaining_pixels() {
        let now = Instant::now();
        let mut state = AnnotationState::default();
        state.begin("lease".into(), geometry());
        let frame = state
            .register("lease", geometry(), 7, (2560, 1440), 0, now)
            .unwrap();
        for seconds in [5, 30, 60, 90, 120, 150] {
            assert_eq!(
                state
                    .register(
                        "lease",
                        geometry(),
                        7,
                        (2560, 1440),
                        0,
                        now + Duration::from_secs(seconds)
                    )
                    .unwrap(),
                frame
            );
        }
        assert_eq!(state.lease.as_ref().unwrap().frames.len(), 1);
        assert!(state
            .frame_geometry(&frame, now + Duration::from_secs(151))
            .is_ok());
        assert!(state
            .frame_geometry(&frame, now + Duration::from_secs(271))
            .is_err());
    }

    #[test]
    fn recent_frame_survives_fast_capture_cadence_and_speech_bursts() {
        let now = Instant::now();
        let mut state = AnnotationState::default();
        state.begin("lease".into(), geometry());
        let first = state
            .register("lease", geometry(), 1, (2560, 1440), 0, now)
            .unwrap();
        // A fast periodic update used to evict the inspected image at 20 seconds,
        // long before its 120-second freshness limit. Speech adds extra captures.
        for tick in 1..=24 {
            let observed_at = now + Duration::from_secs(tick * 5);
            let captures_this_tick = if tick > 4 { 4 } else { 1 };
            for burst in 0..captures_this_tick {
                state
                    .register(
                        "lease",
                        geometry(),
                        tick * 4 + burst,
                        (2560, 1440),
                        0,
                        observed_at,
                    )
                    .unwrap();
            }
            assert_eq!(
                state.frame_geometry(&first, observed_at),
                Ok(geometry()),
                "the inspected frame disappeared at {} seconds",
                tick * 5
            );
        }
        assert_eq!(state.lease.as_ref().unwrap().frames.len(), 85);
        let expired_at = now + FRAME_MAX_AGE + Duration::from_millis(1);
        assert_eq!(
            state.frame_geometry(&first, expired_at).unwrap_err(),
            FRAME_TOO_OLD
        );
        state
            .register("lease", geometry(), 999, (2560, 1440), 0, expired_at)
            .unwrap();
        assert!(state
            .lease
            .as_ref()
            .unwrap()
            .frames
            .iter()
            .all(|frame| frame.id != first));
    }

    #[test]
    fn accepted_pointer_survives_capacity_eviction_during_capture() {
        let now = Instant::now();
        let mut state = AnnotationState::default();
        state.begin("lease".into(), geometry());
        let first = state
            .register("lease", geometry(), 1, (2560, 1440), 0, now)
            .unwrap();
        for fingerprint in 2..=FRAME_LIMIT as u64 {
            state
                .register(
                    "lease",
                    geometry(),
                    fingerprint,
                    (2560, 1440),
                    0,
                    now + Duration::from_secs(1),
                )
                .unwrap();
        }
        state.lease.as_mut().unwrap().capturing = true;
        let mut request = request(ScreenPointerKind::Arrow, 0.5, 0.5);
        request.frame_id = first.clone();
        let pending = state
            .reserve_show(Arc::new(request), now + Duration::from_secs(2))
            .unwrap();
        let finished_at = now + Duration::from_secs(3);
        state
            .register(
                "lease",
                geometry(),
                FRAME_LIMIT as u64 + 1,
                (2560, 1440),
                0,
                finished_at,
            )
            .unwrap();
        assert_eq!(state.lease.as_ref().unwrap().frames.len(), FRAME_LIMIT);
        // New requests cannot borrow an evicted ID. The already accepted request
        // must still use its original image, never substitute the latest frame.
        assert!(state
            .frame_geometry(&pending.request.frame_id, finished_at)
            .is_err());
        assert_eq!(
            state.pending_geometry(&pending, finished_at),
            Ok((geometry(), true))
        );
        assert!(state.finish_capture("lease"));
        assert_eq!(
            state.pending_geometry(&pending, finished_at),
            Ok((geometry(), false))
        );
        assert_eq!(pending.request.frame_id, first);
        assert_ne!(
            pending.request.frame_id,
            state.lease.as_ref().unwrap().frames.back().unwrap().id
        );
    }

    #[test]
    fn accepted_reference_still_expires_and_cannot_borrow_a_new_id_for_identical_pixels() {
        let now = Instant::now();
        let (mut state, initial) = waiting_pointer(now);
        let requested_at = now + FRAME_MAX_AGE - Duration::from_secs(1);
        let pending = state
            .reserve_show(initial.request.clone(), requested_at)
            .unwrap();
        evict_initial_frame(&mut state, requested_at);
        assert_eq!(
            state.pending_geometry(&pending, now + FRAME_MAX_AGE),
            Ok((geometry(), true))
        );
        // The 16-second capture wait cannot extend the inspected image's TTL.
        // Even identical pixels now receive a different ID after cache eviction.
        let expired_at = now + FRAME_MAX_AGE + Duration::from_millis(1);
        assert_eq!(
            state.pending_geometry(&pending, expired_at).unwrap_err(),
            FRAME_TOO_OLD
        );
        let replacement = state
            .register("lease", geometry(), 1, (2560, 1440), 0, expired_at)
            .unwrap();
        assert_ne!(replacement, pending.request.frame_id);
        assert!(state.frame_geometry(&replacement, expired_at).is_ok());
        assert_eq!(
            state.pending_geometry(&pending, expired_at).unwrap_err(),
            FRAME_TOO_OLD
        );
    }

    #[test]
    fn accepted_reference_keeps_same_id_refresh_even_after_capacity_eviction() {
        let now = Instant::now();
        for evict in [false, true] {
            let (mut state, initial) = waiting_pointer(now);
            let pending = state
                .reserve_show(initial.request.clone(), now + Duration::from_secs(115))
                .unwrap();
            let refreshed = state
                .register(
                    "lease",
                    geometry(),
                    1,
                    (2560, 1440),
                    0,
                    now + Duration::from_secs(118),
                )
                .unwrap();
            assert_eq!(refreshed, pending.request.frame_id);
            if evict {
                evict_initial_frame(&mut state, now + Duration::from_secs(119));
                assert!(state
                    .frame_geometry(&refreshed, now + Duration::from_secs(119))
                    .is_err());
            }
            assert!(state.finish_capture("lease"));
            assert_eq!(
                state.pending_geometry(&pending, now + Duration::from_secs(121)),
                Ok((geometry(), false)),
                "same-ID observation must survive cache eviction: {evict}"
            );
        }
    }

    #[test]
    fn evicted_accepted_reference_never_bypasses_revocation() {
        let now = Instant::now();
        for operation in 0..8 {
            let (mut state, pending) = waiting_pointer(now);
            evict_initial_frame(&mut state, now);
            assert!(state.pending_geometry(&pending, now).is_ok());
            match operation {
                0 => state.clear(),
                1 => {
                    state.end("lease");
                }
                2 => state.reload(),
                3 => state.begin("replacement-lease".into(), geometry()),
                4 => {
                    let document = state.document_id.clone();
                    state.set_enabled(&document, 1, false).unwrap();
                    assert_eq!(
                        state.pending_geometry(&pending, now).unwrap_err(),
                        POINTERS_DISABLED
                    );
                    state.set_enabled(&document, 2, true).unwrap();
                }
                5 => {
                    let document = state.document_id.clone();
                    state.set_enabled(&document, 2, true).unwrap();
                }
                6 => {
                    state.lease.as_mut().unwrap().geometry.source_id += 1;
                }
                _ => {
                    let mut replacement = request(ScreenPointerKind::Arrow, 0.1, 0.1);
                    replacement.frame_id = state
                        .lease
                        .as_ref()
                        .unwrap()
                        .frames
                        .back()
                        .unwrap()
                        .id
                        .clone();
                    state.reserve_show(Arc::new(replacement), now).unwrap();
                }
            }
            assert!(state.pending_geometry(&pending, now).is_err());
        }
    }

    fn evict_initial_frame(state: &mut AnnotationState, now: Instant) {
        for fingerprint in 2..=FRAME_LIMIT as u64 + 1 {
            state
                .register("lease", geometry(), fingerprint, (2560, 1440), 0, now)
                .unwrap();
        }
    }

    #[test]
    fn capture_completion_does_not_resurrect_expired_marks() {
        let now = Instant::now();
        let (mut state, pending) = waiting_pointer(now);
        state.active_capture = Some("lease".into());
        state.visible = Some(VisibleAnnotation {
            generation: pending.generation,
            geometry: geometry(),
            target: AnnotationTarget::Arrow { x: 100.0, y: 100.0 },
            label: Some("test".into()),
            expires_at: now + Duration::from_secs(1),
        });
        let expiry = state.visible.as_ref().unwrap().expires_at;
        assert!(state.finish_capture("lease"));
        assert_eq!(state.visible.as_ref().unwrap().expires_at, expiry);
        state.active_capture = Some("lease".into());
        state.expire_visible(pending.generation);
        assert!(state.finish_capture("lease"));
        assert!(state.visible.is_none());
    }

    #[test]
    fn restarted_sharing_waits_for_old_capture_without_replaying_a_mark() {
        let now = Instant::now();
        let (mut state, _) = waiting_pointer(now);
        state.active_capture = Some("lease".into());
        state.end("lease");
        state.begin("new".into(), geometry());
        let frame = state
            .register("new", geometry(), 1, (2560, 1440), 0, now)
            .unwrap();
        let mut req = request(ScreenPointerKind::Arrow, 0.5, 0.5);
        req.frame_id = frame;
        let pending = state.reserve_show(Arc::new(req), now).unwrap();
        assert!(state.pending_geometry(&pending, now).unwrap().1);
        assert!(!state.finish_capture("lease"));
        assert!(!state.pending_geometry(&pending, now).unwrap().1);
        assert_eq!(state.lease.as_ref().unwrap().id, "new");
        assert!(state.visible.is_none());
    }

    #[test]
    fn captures_are_bounded_and_pointer_requests_wait_during_capture() {
        let now = Instant::now();
        let mut state = AnnotationState::default();
        state.begin("lease".into(), geometry());
        let first = state
            .register("lease", geometry(), 1, (2560, 1440), 0, now)
            .unwrap();
        for fingerprint in 2..=FRAME_LIMIT as u64 + 1 {
            state
                .register("lease", geometry(), fingerprint, (2560, 1440), 0, now)
                .unwrap();
        }
        assert_eq!(state.lease.as_ref().unwrap().frames.len(), FRAME_LIMIT);
        assert!(state.frame_geometry(&first, now).is_err());
        let latest = state
            .lease
            .as_ref()
            .unwrap()
            .frames
            .back()
            .unwrap()
            .id
            .clone();
        state.lease.as_mut().unwrap().capturing = true;
        let mut request = request(ScreenPointerKind::Arrow, 0.5, 0.5);
        request.frame_id = latest;
        let pending = state.reserve_show(Arc::new(request), now).unwrap();
        assert_eq!(
            state.pending_geometry(&pending, now).unwrap(),
            (geometry(), true)
        );
        assert!(state.visible.is_none());
        assert!(state.finish_capture("lease"));
        assert_eq!(
            state.pending_geometry(&pending, now).unwrap(),
            (geometry(), false)
        );
    }

    fn waiting_pointer(now: Instant) -> (AnnotationState, PendingShow) {
        let mut state = AnnotationState::default();
        state.begin("lease".into(), geometry());
        let frame = state
            .register("lease", geometry(), 1, (2560, 1440), 0, now)
            .unwrap();
        state.lease.as_mut().unwrap().capturing = true;
        let mut request = request(ScreenPointerKind::Arrow, 0.5, 0.5);
        request.frame_id = frame;
        let pending = state.reserve_show(Arc::new(request), now).unwrap();
        (state, pending)
    }

    #[tokio::test]
    async fn disabling_immediately_clears_and_wakes_waiters_without_stopping_sharing() {
        let now = Instant::now();
        let (mut state, pending) = waiting_pointer(now);
        let document = state.document_id.clone();
        state.visible = Some(VisibleAnnotation {
            generation: pending.generation,
            geometry: geometry(),
            target: AnnotationTarget::Arrow { x: 100.0, y: 200.0 },
            label: None,
            expires_at: now + Duration::from_secs(8),
        });
        let mut changes = state.changes.subscribe();
        assert!(state.set_enabled(&document, 1, false).unwrap());
        tokio::time::timeout(Duration::from_millis(100), changes.changed())
            .await
            .unwrap()
            .unwrap();
        assert!(state.visible.is_none());
        assert_eq!(state.lease.as_ref().unwrap().id, "lease");
        assert!(state.lease.as_ref().unwrap().capturing);
        assert_eq!(
            state.pending_geometry(&pending, now).unwrap_err(),
            POINTERS_DISABLED
        );
        assert_eq!(
            state
                .frame_geometry(&pending.request.frame_id, now)
                .unwrap_err(),
            POINTERS_DISABLED
        );
        assert!(state.reserve_show(pending.request.clone(), now).is_err());
        assert!(state.finish_capture("lease"));
        assert!(state.visible.is_none());

        assert!(state.set_enabled(&document, 2, true).unwrap());
        assert!(state.visible.is_none());
        assert!(state.pending_geometry(&pending, now).is_err());
        assert!(state
            .frame_geometry(&pending.request.frame_id, now)
            .is_err());
        let fresh = state
            .register(
                "lease",
                geometry(),
                1,
                (2560, 1440),
                state.pointer_epoch,
                now,
            )
            .unwrap();
        assert_ne!(fresh, pending.request.frame_id);
        assert!(state.frame_geometry(&fresh, now).is_ok());
    }

    #[test]
    fn reordered_toggles_and_old_documents_cannot_restore_marks_or_change_the_preference() {
        let now = Instant::now();
        let (mut state, pending) = waiting_pointer(now);
        let old_document = state.document_id.clone();
        // ON revision 2 overtakes OFF revision 1. It must still revoke old work.
        assert!(state.set_enabled(&old_document, 2, true).unwrap());
        assert!(state.pending_geometry(&pending, now).is_err());
        assert!(state
            .frame_geometry(&pending.request.frame_id, now)
            .is_err());
        assert!(state.set_enabled(&old_document, 1, false).is_err());
        assert!(state.pointers_enabled);
        state.set_enabled(&old_document, 3, false).unwrap();
        assert!(state.set_enabled(&old_document, 2, true).is_err());
        state.reload();
        assert!(!state.pointers_enabled);
        assert!(state.set_enabled(&old_document, 99, true).is_err());
        assert!(!state.pointers_enabled);
        let document = state.document_id.clone();
        assert!(!state.set_enabled(&document, 1, false).unwrap());
        assert!(state.set_enabled(&document, 1, true).is_err());
        assert!(!state.pointers_enabled);
    }

    #[tokio::test]
    async fn capture_completion_before_await_is_not_lost_and_old_lease_cannot_release_wait() {
        let now = Instant::now();
        let (mut state, pending) = waiting_pointer(now);
        let mut changes = state.changes.subscribe();
        assert!(!state.finish_capture("old-lease"));
        assert!(!changes.has_changed().unwrap());
        assert!(state.finish_capture("lease"));
        tokio::time::timeout(Duration::from_millis(100), changes.changed())
            .await
            .unwrap()
            .unwrap();
        assert!(!state.pending_geometry(&pending, now).unwrap().1);
    }

    #[test]
    fn clear_stop_reload_and_replacement_cancel_waiting_requests() {
        let now = Instant::now();
        for operation in 0..5 {
            let (mut state, pending) = waiting_pointer(now);
            let changes = state.changes.subscribe();
            match operation {
                0 => state.clear(),
                1 => {
                    state.end("lease");
                }
                2 => state.reload(),
                3 => state.begin("replacement-lease".into(), geometry()),
                _ => {
                    let replacement = state.reserve_show(pending.request.clone(), now).unwrap();
                    assert!(state.pending_geometry(&replacement, now).is_ok());
                }
            }
            assert!(changes.has_changed().unwrap());
            assert!(state.pending_geometry(&pending, now).is_err());
        }
    }

    #[test]
    fn pending_request_revalidates_frame_age_and_display_geometry() {
        let now = Instant::now();
        let (mut state, pending) = waiting_pointer(now);
        assert!(state
            .pending_geometry(&pending, now + FRAME_MAX_AGE + Duration::from_millis(1))
            .is_err());
        state.lease.as_mut().unwrap().geometry.x += 1.0;
        assert!(state.pending_geometry(&pending, now).is_err());
    }

    #[test]
    fn older_mark_expiry_does_not_cancel_a_newer_waiting_request() {
        let now = Instant::now();
        let (mut state, pending) = waiting_pointer(now);
        let old_generation = pending.generation.wrapping_sub(1);
        state.visible = Some(VisibleAnnotation {
            generation: old_generation,
            geometry: geometry(),
            target: AnnotationTarget::Arrow { x: 1.0, y: 2.0 },
            label: None,
            expires_at: now,
        });
        state.expire_visible(old_generation);
        assert!(state.visible.is_none());
        assert!(state.pending_geometry(&pending, now).is_ok());
        state.clear();
        assert!(state.pending_geometry(&pending, now).is_err());
    }

    #[test]
    fn timeout_and_caller_cancellation_disarm_queued_ui_actions() {
        let now = Instant::now();
        let lifetime = Arc::new(ShowLifetime {
            cancelled: AtomicBool::new(false),
            deadline: now + POINTER_CAPTURE_WAIT,
        });
        assert!(lifetime.check(now).is_ok());
        assert!(lifetime.check(now + Duration::from_secs(3)).is_ok());
        assert!(lifetime.check(now + POINTER_CAPTURE_WAIT).is_err());
        let queued_callback_lifetime = lifetime.clone();
        drop(CancelShowOnDrop(lifetime));
        assert!(queued_callback_lifetime.check(now).is_err());
    }

    #[test]
    fn expiry_clear_and_geometry_watchdog_do_not_hide_newer_marks() {
        let now = Instant::now();
        let mut state = AnnotationState::default();
        state.begin("lease".into(), geometry());
        state.visible = Some(VisibleAnnotation {
            generation: 2,
            geometry: geometry(),
            target: AnnotationTarget::Arrow { x: 10.0, y: 20.0 },
            label: None,
            expires_at: now + Duration::from_secs(8),
        });
        assert!(!state.should_hide(1, now + Duration::from_secs(10), Some(geometry())));
        assert!(!state.should_hide(2, now, Some(geometry())));
        assert!(state.should_hide(2, now + Duration::from_secs(8), Some(geometry())));
        assert!(state.should_hide(2, now, None));
        state.clear();
        assert!(state.visible.is_none());
        assert!(state.lease.is_some());
    }
}
