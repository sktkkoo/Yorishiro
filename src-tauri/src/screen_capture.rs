//! Host-owned, opt-in desktop snapshots for the shared screen companion.
//!
//! Listing displays never captures pixels or requests permission. Only the explicit
//! permission command may show the macOS prompt; individual captures only preflight
//! permission. Frames are bounded JPEGs kept in memory and are never logged or saved.

use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenCaptureSource {
    pub id: u32,
    pub name: String,
    pub width: usize,
    pub height: usize,
}

// Intentionally no Debug implementation: the data URL contains private pixels.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenCaptureFrame {
    pub source_id: u32,
    pub source_name: String,
    pub captured_at: u64,
    pub data_url: String,
    pub width: usize,
    pub height: usize,
}

const UNSUPPORTED: &str = "Screen sharing requires macOS 14 or later.";

fn require_host(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Screen sharing is available only to the main application window.".into())
    }
}

#[tauri::command]
pub fn screen_capture_list_sources(
    window: tauri::WebviewWindow,
) -> Result<Vec<ScreenCaptureSource>, String> {
    require_host(&window)?;
    #[cfg(target_os = "macos")]
    return macos::list_sources();
    #[cfg(not(target_os = "macos"))]
    Err(UNSUPPORTED.into())
}

/// Called only by the host's user-initiated Start sharing control.
#[tauri::command]
pub async fn screen_capture_request_permission(
    window: tauri::WebviewWindow,
) -> Result<bool, String> {
    require_host(&window)?;
    #[cfg(target_os = "macos")]
    {
        macos::ensure_supported()?;
        let (sender, receiver) = tokio::sync::oneshot::channel();
        window
            .run_on_main_thread(move || {
                let _ = sender.send(macos::request_permission());
            })
            .map_err(|_| "Could not request screen recording permission.".to_string())?;
        receiver
            .await
            .map_err(|_| "Screen recording permission request was cancelled.".to_string())
    }
    #[cfg(not(target_os = "macos"))]
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub async fn screen_capture_frame(
    window: tauri::WebviewWindow,
    source_id: u32,
) -> Result<ScreenCaptureFrame, String> {
    require_host(&window)?;
    #[cfg(target_os = "macos")]
    return macos::capture(source_id).await;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = source_id;
        Err(UNSUPPORTED.into())
    }
}

#[cfg(any(target_os = "macos", test))]
const MAX_IMAGE_EDGE: usize = 2560;

#[cfg(any(target_os = "macos", test))]
fn bounded_dimensions(width: usize, height: usize) -> Result<(usize, usize), String> {
    if width == 0 || height == 0 {
        return Err("The selected display has no visible area.".into());
    }
    let longest = width.max(height);
    if longest <= MAX_IMAGE_EDGE {
        return Ok((width, height));
    }
    // Floating point avoids overflow even for malformed display dimensions.
    let scale = MAX_IMAGE_EDGE as f64 / longest as f64;
    Ok((
        ((width as f64 * scale).floor() as usize).clamp(1, MAX_IMAGE_EDGE),
        ((height as f64 * scale).floor() as usize).clamp(1, MAX_IMAGE_EDGE),
    ))
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{bounded_dimensions, ScreenCaptureFrame, ScreenCaptureSource, MAX_IMAGE_EDGE};
    use base64::Engine;
    use block2::RcBlock;
    use objc2::rc::{autoreleasepool, Retained};
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2::{msg_send, AnyThread};
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImageCompressionFactor};
    use objc2_foundation::{NSArray, NSData, NSDictionary, NSNumber};
    use std::ffi::{c_void, CStr};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex, OnceLock};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    use tokio::sync::oneshot;

    const PERMISSION_DENIED: &str = "Screen recording permission is not granted. Enable Yorishiro in System Settings > Privacy & Security > Screen & System Audio Recording (Screen Recording on older macOS), then restart Yorishiro if requested.";
    const MAX_JPEG_BYTES: usize = 8 * 1024 * 1024;
    static CAPTURE_BUSY: AtomicBool = AtomicBool::new(false);

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGGetActiveDisplayList(max_displays: u32, displays: *mut u32, count: *mut u32) -> i32;
        fn CGMainDisplayID() -> u32;
        fn CGDisplayPixelsWide(display: u32) -> usize;
        fn CGDisplayPixelsHigh(display: u32) -> usize;
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
        fn CGImageGetWidth(image: *const c_void) -> usize;
        fn CGImageGetHeight(image: *const c_void) -> usize;
    }

    /// Resolve the screenshot API at runtime so older macOS can still launch the
    /// app. The fixed system framework is kept loaded for the application's life.
    pub(super) fn ensure_supported() -> Result<(), String> {
        static LOADED: OnceLock<bool> = OnceLock::new();
        let loaded = LOADED.get_or_init(|| unsafe {
            !libc::dlopen(
                c"/System/Library/Frameworks/ScreenCaptureKit.framework/ScreenCaptureKit".as_ptr(),
                libc::RTLD_NOW | libc::RTLD_LOCAL,
            )
            .is_null()
        });
        if *loaded && AnyClass::get(c"SCScreenshotManager").is_some() {
            Ok(())
        } else {
            Err(super::UNSUPPORTED.into())
        }
    }

    fn sc_class(name: &CStr) -> Result<&'static AnyClass, String> {
        AnyClass::get(name).ok_or_else(|| super::UNSUPPORTED.into())
    }

    pub(super) fn list_sources() -> Result<Vec<ScreenCaptureSource>, String> {
        ensure_supported()?;
        // CoreGraphics display metadata does not require screen recording access.
        let mut ids = [0_u32; 32];
        let mut count = 0;
        let result =
            unsafe { CGGetActiveDisplayList(ids.len() as u32, ids.as_mut_ptr(), &mut count) };
        if result != 0 {
            return Err(format!(
                "Could not list displays (CoreGraphics error {result})."
            ));
        }
        let primary = unsafe { CGMainDisplayID() };
        let mut displays = ids[..(count as usize).min(ids.len())]
            .iter()
            .enumerate()
            .map(|(index, id)| ScreenCaptureSource {
                id: *id,
                name: format!(
                    "Display {}{}",
                    index + 1,
                    if *id == primary { " (Main)" } else { "" }
                ),
                width: unsafe { CGDisplayPixelsWide(*id) },
                height: unsafe { CGDisplayPixelsHigh(*id) },
            })
            .filter(|display| display.width > 0 && display.height > 0)
            .collect::<Vec<_>>();
        displays.sort_by_key(|display| display.id != primary);
        Ok(displays)
    }

    pub(super) fn request_permission() -> bool {
        unsafe { CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess() }
    }

    struct BusyGuard;

    impl Drop for BusyGuard {
        fn drop(&mut self) {
            CAPTURE_BUSY.store(false, Ordering::Release);
        }
    }

    struct CaptureRequest {
        cancelled: AtomicBool,
        sender: Mutex<Option<oneshot::Sender<Result<ScreenCaptureFrame, String>>>>,
        // The guard is held by the native callbacks, including after a timeout.
        // A late OS callback cannot cause overlapping captures to accumulate.
        _busy: BusyGuard,
    }

    impl CaptureRequest {
        fn complete(&self, result: Result<ScreenCaptureFrame, String>) {
            if let Ok(mut sender) = self.sender.lock() {
                if let Some(sender) = sender.take() {
                    if !self.cancelled.load(Ordering::Acquire) {
                        let _ = sender.send(result);
                    }
                }
            }
        }
    }

    struct CancelOnDrop(Arc<CaptureRequest>);

    impl Drop for CancelOnDrop {
        fn drop(&mut self) {
            self.0.cancelled.store(true, Ordering::Release);
        }
    }

    pub(super) async fn capture(source_id: u32) -> Result<ScreenCaptureFrame, String> {
        ensure_supported()?;
        if !unsafe { CGPreflightScreenCaptureAccess() } {
            return Err(PERMISSION_DENIED.into());
        }
        let source = list_sources()?
            .into_iter()
            .find(|source| source.id == source_id)
            .ok_or_else(|| {
                "The selected display is no longer available. Choose a display again.".to_string()
            })?;
        let dimensions = bounded_dimensions(source.width, source.height)?;
        CAPTURE_BUSY
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .map_err(|_| "A screen capture is already in progress.".to_string())?;
        let (sender, receiver) = oneshot::channel();
        let request = Arc::new(CaptureRequest {
            cancelled: AtomicBool::new(false),
            sender: Mutex::new(Some(sender)),
            _busy: BusyGuard,
        });
        let _cancel = CancelOnDrop(request.clone());
        autoreleasepool(|_| begin_capture(request, source, dimensions))?;
        tokio::time::timeout(Duration::from_secs(15), receiver)
            .await
            .map_err(|_| "Screen capture timed out. Stop sharing and try again.".to_string())?
            .map_err(|_| "Screen capture was cancelled.".to_string())?
    }

    fn begin_capture(
        request: Arc<CaptureRequest>,
        source: ScreenCaptureSource,
        dimensions: (usize, usize),
    ) -> Result<(), String> {
        let content_class = sc_class(c"SCShareableContent")?;
        let callback = RcBlock::new(move |content: *mut AnyObject, error: *mut AnyObject| {
            autoreleasepool(|_| {
                if request.cancelled.load(Ordering::Acquire) {
                    return;
                }
                if !error.is_null() || content.is_null() {
                    request.complete(Err(capture_error(error)));
                    return;
                }
                // SCShareableContent owns the display objects throughout this
                // callback. The filter retains the selected display after it.
                let result = unsafe {
                    capture_from_content(content, request.clone(), source.clone(), dimensions)
                };
                if let Err(error) = result {
                    request.complete(Err(error));
                }
            });
        });
        unsafe {
            let _: () =
                msg_send![content_class, getShareableContentWithCompletionHandler: &*callback];
        }
        Ok(())
    }

    unsafe fn capture_from_content(
        content: *mut AnyObject,
        request: Arc<CaptureRequest>,
        source: ScreenCaptureSource,
        dimensions: (usize, usize),
    ) -> Result<(), String> {
        let displays: *mut AnyObject = msg_send![content, displays];
        if displays.is_null() {
            return Err("No displays are available for screen sharing.".into());
        }
        let count: usize = msg_send![displays, count];
        let mut selected = std::ptr::null_mut::<AnyObject>();
        for index in 0..count {
            let display: *mut AnyObject = msg_send![displays, objectAtIndex: index];
            let id: u32 = msg_send![display, displayID];
            if id == source.id {
                selected = display;
                break;
            }
        }
        if selected.is_null() {
            return Err(
                "The selected display is no longer available. Choose a display again.".into(),
            );
        }
        let empty_windows = NSArray::<AnyObject>::new();
        let filter: Option<Retained<AnyObject>> = msg_send![
            msg_send![sc_class(c"SCContentFilter")?, alloc],
            initWithDisplay: selected,
            excludingWindows: &*empty_windows,
        ];
        let filter =
            filter.ok_or_else(|| "Could not configure the selected display.".to_string())?;
        let configuration: Retained<AnyObject> =
            msg_send![sc_class(c"SCStreamConfiguration")?, new];
        let _: () = msg_send![&*configuration, setWidth: dimensions.0];
        let _: () = msg_send![&*configuration, setHeight: dimensions.1];
        let _: () = msg_send![&*configuration, setShowsCursor: Bool::YES];
        let _: () = msg_send![&*configuration, setCapturesAudio: Bool::NO];
        let callback = RcBlock::new(move |image: *const c_void, error: *mut AnyObject| {
            autoreleasepool(|_| {
                if request.cancelled.load(Ordering::Acquire) {
                    return;
                }
                if !error.is_null() || image.is_null() {
                    request.complete(Err(capture_error(error)));
                    return;
                }
                // The image is borrowed from ScreenCaptureKit and remains valid
                // for this callback; NSBitmapImageRep retains it during encoding.
                // Do not CGImageRelease the borrowed image.
                let captured_at = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;
                let result = encode_frame(image, &source, captured_at);
                request.complete(result);
            });
        });
        let _: () = msg_send![
            sc_class(c"SCScreenshotManager")?,
            captureImageWithFilter: &*filter,
            configuration: &*configuration,
            completionHandler: &*callback,
        ];
        Ok(())
    }

    fn capture_error(error: *mut AnyObject) -> String {
        if !unsafe { CGPreflightScreenCaptureAccess() } {
            return PERMISSION_DENIED.into();
        }
        if error.is_null() {
            "ScreenCaptureKit returned no image. The selected display may be unavailable.".into()
        } else {
            // Numeric error only: do not copy arbitrary application/window details
            // from an OS error into diagnostics or agent context.
            let code: isize = unsafe { msg_send![error, code] };
            format!("ScreenCaptureKit could not capture the display (error {code}).")
        }
    }

    fn encode_frame(
        image: *const c_void,
        source: &ScreenCaptureSource,
        captured_at: u64,
    ) -> Result<ScreenCaptureFrame, String> {
        unsafe {
            let width = CGImageGetWidth(image);
            let height = CGImageGetHeight(image);
            if width == 0 || height == 0 || width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE {
                return Err("Screen capture returned unexpected image dimensions.".into());
            }
            let bitmap: Option<Retained<NSBitmapImageRep>> =
                msg_send![NSBitmapImageRep::alloc(), initWithCGImage: image];
            let bitmap = bitmap.ok_or_else(|| "Could not encode screen capture.".to_string())?;
            let quality = NSNumber::new_f64(0.9);
            let properties = NSDictionary::from_slices(&[NSImageCompressionFactor], &[&*quality]);
            let data: Option<Retained<NSData>> = msg_send![
                &*bitmap,
                representationUsingType: NSBitmapImageFileType::JPEG,
                properties: &*properties,
            ];
            let data =
                data.ok_or_else(|| "Could not encode screen capture as JPEG.".to_string())?;
            let length: usize = msg_send![&*data, length];
            let bytes: *const u8 = msg_send![&*data, bytes];
            if bytes.is_null() || length == 0 || length > MAX_JPEG_BYTES {
                return Err(
                    "Screen capture exceeded the image size limit or returned an empty image."
                        .into(),
                );
            }
            let data_url = format!(
                "data:image/jpeg;base64,{}",
                base64::engine::general_purpose::STANDARD
                    .encode(std::slice::from_raw_parts(bytes, length))
            );
            Ok(ScreenCaptureFrame {
                source_id: source.id,
                source_name: source.name.clone(),
                captured_at,
                data_url,
                width,
                height,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{bounded_dimensions, MAX_IMAGE_EDGE};

    #[test]
    fn bounds_retina_and_portrait_images_without_upscaling() {
        assert_eq!(bounded_dimensions(5120, 2880).unwrap(), (2560, 1440));
        assert_eq!(bounded_dimensions(2880, 5120).unwrap(), (1440, 2560));
        assert_eq!(bounded_dimensions(640, 480).unwrap(), (640, 480));
        assert_eq!(
            bounded_dimensions(1, usize::MAX).unwrap(),
            (1, MAX_IMAGE_EDGE)
        );
    }

    #[test]
    fn rejects_disconnected_display_dimensions() {
        assert!(bounded_dimensions(0, 1080).is_err());
        assert!(bounded_dimensions(1920, 0).is_err());
    }
}
