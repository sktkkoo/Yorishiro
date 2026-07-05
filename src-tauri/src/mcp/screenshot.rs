//! macOS ウィンドウスクリーンショットキャプチャ。
//!
//! CGWindowListCreateImage で OS ウィンドウサーバーの合成済みピクセルをキャプチャ
//! する。WKWebView.takeSnapshotWithConfiguration と異なり、WebGL canvas に掛けた
//! CSS filter (drop-shadow 等) も正確に反映される。
//!
//! 注: 初回使用時に macOS「画面収録」(Screen Recording) 許可ダイアログが表示される。

use rmcp::model::CallToolResult;
use rmcp::ErrorData as McpError;
use tauri::AppHandle;

#[cfg(target_os = "macos")]
pub async fn capture_webview_screenshot(app: &AppHandle) -> Result<CallToolResult, McpError> {
    use base64::Engine;
    use rmcp::model::Content;
    use tauri::{Emitter, Manager};

    let webview = app
        .get_webview_window("main")
        .ok_or_else(|| McpError::internal_error("no main webview window", None))?;

    let (tx, rx) = tokio::sync::oneshot::channel::<Result<Vec<u8>, String>>();

    webview
        .with_webview(move |platform_webview| {
            capture_window_image(platform_webview.inner(), tx);
        })
        .map_err(|e| McpError::internal_error(format!("with_webview failed: {e}"), None))?;

    let png_bytes = rx
        .await
        .map_err(|_| McpError::internal_error("screenshot channel dropped", None))?
        .map_err(|e| McpError::internal_error(e, None))?;

    // 撮影が完了して PNG bytes を握った後に JS 側へ flash 発火を通知する。
    // 撮影 → bytes 確定 → emit の順序なので flash 自体は撮影画像に写り込まない。
    let _ = app.emit("yorishiro:screen-flash", ());

    let base64_data = base64::engine::general_purpose::STANDARD.encode(&png_bytes);
    let content = Content::image(base64_data, "image/png");
    Ok(CallToolResult::success(vec![content]))
}

/// WKWebView が属する NSWindow の windowNumber を取得し、
/// CGWindowListCreateImage でウィンドウの合成済みピクセルをキャプチャする。
///
/// with_webview callback 内（main thread）で呼ばれる前提。
#[cfg(target_os = "macos")]
fn capture_window_image(
    wk_webview: *mut std::ffi::c_void,
    tx: tokio::sync::oneshot::Sender<Result<Vec<u8>, String>>,
) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    if wk_webview.is_null() {
        let _ = tx.send(Err("null WKWebView pointer".into()));
        return;
    }

    let wk: *mut AnyObject = wk_webview.cast();

    let result = unsafe {
        let ns_window: *mut AnyObject = msg_send![wk, window];
        if ns_window.is_null() {
            Err("WKWebView has no window".to_string())
        } else {
            let window_number: isize = msg_send![ns_window, windowNumber];
            if window_number <= 0 {
                Err(format!("invalid windowNumber: {window_number}"))
            } else {
                capture_cg_window(window_number as u32)
            }
        }
    };

    let _ = tx.send(result);
}

/// CGWindowListCreateImage で指定ウィンドウの合成済みピクセルを取得し、
/// NSBitmapImageRep 経由で PNG bytes に変換する。
#[cfg(target_os = "macos")]
fn capture_cg_window(window_id: u32) -> Result<Vec<u8>, String> {
    use std::ffi::c_void;

    #[repr(C)]
    #[derive(Copy, Clone)]
    struct CGPoint {
        x: f64,
        y: f64,
    }
    #[repr(C)]
    #[derive(Copy, Clone)]
    struct CGSize {
        width: f64,
        height: f64,
    }
    #[repr(C)]
    #[derive(Copy, Clone)]
    struct CGRect {
        origin: CGPoint,
        size: CGSize,
    }

    // kCGWindowListOptionIncludingWindow — capture only the specified window.
    const LIST_OPTION: u32 = 1 << 3;
    // kCGWindowImageBoundsIgnoreFraming — content bounds only, no OS chrome.
    const IMAGE_OPTION: u32 = 1 << 0;

    // CGRectNull — lets CGWindowListCreateImage use the window's own bounds.
    let cg_rect_null = CGRect {
        origin: CGPoint {
            x: f64::INFINITY,
            y: f64::INFINITY,
        },
        size: CGSize {
            width: 0.0,
            height: 0.0,
        },
    };

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGWindowListCreateImage(
            screenBounds: CGRect,
            listOption: u32,
            windowID: u32,
            imageOption: u32,
        ) -> *mut c_void;
        fn CGImageRelease(image: *mut c_void);
    }

    unsafe {
        let cg_image = CGWindowListCreateImage(cg_rect_null, LIST_OPTION, window_id, IMAGE_OPTION);

        if cg_image.is_null() {
            return Err("CGWindowListCreateImage returned null — \
                 Screen Recording permission may be required. \
                 Grant it in System Settings > Privacy & Security > Screen Recording."
                .to_string());
        }

        let result = cgimage_to_png(cg_image);
        CGImageRelease(cg_image);
        result
    }
}

/// CGImageRef → NSBitmapImageRep → PNG bytes。
#[cfg(target_os = "macos")]
fn cgimage_to_png(cg_image: *mut std::ffi::c_void) -> Result<Vec<u8>, String> {
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::AnyThread;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep};
    use objc2_foundation::{NSData, NSDictionary};

    unsafe {
        let bitmap_rep: Option<Retained<NSBitmapImageRep>> =
            msg_send![NSBitmapImageRep::alloc(), initWithCGImage: cg_image];
        let bitmap_rep = bitmap_rep
            .ok_or_else(|| "NSBitmapImageRep initWithCGImage returned nil".to_string())?;

        let empty_props = NSDictionary::<AnyObject, AnyObject>::new();
        let png_data: Option<Retained<NSData>> = msg_send![
            &*bitmap_rep,
            representationUsingType: NSBitmapImageFileType::PNG,
            properties: &*empty_props,
        ];
        let png_data =
            png_data.ok_or_else(|| "PNG representationUsingType returned nil".to_string())?;

        let length: usize = msg_send![&*png_data, length];
        let bytes_ptr: *const u8 = msg_send![&*png_data, bytes];
        if bytes_ptr.is_null() || length == 0 {
            return Err("NSData bytes returned null or empty".to_string());
        }
        Ok(std::slice::from_raw_parts(bytes_ptr, length).to_vec())
    }
}

#[cfg(not(target_os = "macos"))]
pub async fn capture_webview_screenshot(_app: &AppHandle) -> Result<CallToolResult, McpError> {
    Err(McpError::internal_error(
        "app.screenshot is only available on macOS",
        None,
    ))
}
