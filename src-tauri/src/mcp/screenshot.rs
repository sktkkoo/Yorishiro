//! macOS WKWebView スクリーンショットキャプチャ。
//!
//! `Webview::with_webview` で WKWebView にアクセスし、
//! `takeSnapshotWithConfiguration:completionHandler:` で webview 全体の
//! スクリーンショットを PNG bytes として取得する。
//!
//! ObjC completion handler → Rust async の橋渡しは oneshot channel。

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
            take_wkwebview_snapshot(platform_webview.inner(), tx);
        })
        .map_err(|e| McpError::internal_error(format!("with_webview failed: {e}"), None))?;

    let png_bytes = rx
        .await
        .map_err(|_| McpError::internal_error("screenshot channel dropped", None))?
        .map_err(|e| McpError::internal_error(e, None))?;

    // 撮影が完了して PNG bytes を握った後に JS 側へ flash 発火を通知する。
    // 撮影 → bytes 確定 → emit の順序なので flash 自体は撮影画像に写り込まない。
    let _ = app.emit("charminal:screen-flash", ());

    let base64_data = base64::engine::general_purpose::STANDARD.encode(&png_bytes);
    let content = Content::image(base64_data, "image/png");
    Ok(CallToolResult::success(vec![content]))
}

/// WKWebView の takeSnapshotWithConfiguration:completionHandler: を ObjC runtime
/// 経由で呼び出し、結果を oneshot channel で送信する。main thread で実行される前提。
///
/// ObjC block は Fn（複数回呼び出し可能）を要求するため、oneshot::Sender を
/// Mutex<Option<...>> でラップして interior mutability で FnOnce semantics を実現する。
#[cfg(target_os = "macos")]
fn take_wkwebview_snapshot(
    wk_webview: *mut std::ffi::c_void,
    tx: tokio::sync::oneshot::Sender<Result<Vec<u8>, String>>,
) {
    use block2::RcBlock;
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use std::ptr;
    use std::sync::Mutex;

    if wk_webview.is_null() {
        let _ = tx.send(Err("null WKWebView pointer".into()));
        return;
    }

    let wk: *mut AnyObject = wk_webview.cast();

    // oneshot::Sender は FnOnce（consume on send）なので Mutex<Option<>> でラップ。
    // completion handler は実際には 1 回しか呼ばれないが、block2 の型制約は Fn を要求する。
    let tx = Mutex::new(Some(tx));

    let block = RcBlock::new(move |image: *mut AnyObject, _error: *mut AnyObject| {
        if let Some(tx) = tx.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let result = if image.is_null() {
                Err("takeSnapshot returned nil image".to_string())
            } else {
                nsimage_to_png(image)
            };
            let _ = tx.send(result);
        }
    });

    unsafe {
        let _: () = msg_send![
            wk,
            takeSnapshotWithConfiguration: ptr::null::<AnyObject>(),
            completionHandler: &*block,
        ];
    }
}

/// NSImage → TIFFRepresentation → NSBitmapImageRep → PNG bytes。
/// typed wrapper の feature 不足を回避するため、msg_send で raw 呼び出し。
#[cfg(target_os = "macos")]
fn nsimage_to_png(ns_image: *mut objc2::runtime::AnyObject) -> Result<Vec<u8>, String> {
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::ClassType;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep};
    use objc2_foundation::{NSData, NSDictionary};

    unsafe {
        // [nsImage TIFFRepresentation] -> NSData
        let tiff_data: Option<Retained<NSData>> = msg_send![ns_image, TIFFRepresentation];
        let tiff_data = tiff_data.ok_or_else(|| "TIFFRepresentation returned nil".to_string())?;

        // [NSBitmapImageRep imageRepWithData:tiffData] -> NSBitmapImageRep
        let bitmap_rep: Option<Retained<NSBitmapImageRep>> =
            msg_send![NSBitmapImageRep::class(), imageRepWithData: &*tiff_data];
        let bitmap_rep = bitmap_rep
            .ok_or_else(|| "NSBitmapImageRep imageRepWithData returned nil".to_string())?;

        // [bitmapRep representationUsingType:NSBitmapImageFileTypePNG properties:@{}]
        let empty_props = NSDictionary::<AnyObject, AnyObject>::new();
        let png_data: Option<Retained<NSData>> = msg_send![
            &*bitmap_rep,
            representationUsingType: NSBitmapImageFileType::PNG,
            properties: &*empty_props,
        ];
        let png_data =
            png_data.ok_or_else(|| "PNG representationUsingType returned nil".to_string())?;

        // NSData → Vec<u8>: raw msg_send で length + bytes を取得
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
