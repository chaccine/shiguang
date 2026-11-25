//! A paint-only event over the existing Tauri event and Android JNI capabilities.
use tauri::{AppHandle, Listener, Manager};

pub fn listen(app: &AppHandle) {
    let handle = app.clone();
    app.listen("shiguang-bar-theme", move |event| {
        let Ok(dark) = serde_json::from_str::<bool>(event.payload()) else {
            return;
        };
        let Some(window) = handle.get_webview_window("main") else {
            return;
        };
        let _ = window.with_webview(move |webview| {
            webview.jni_handle().exec(move |env, activity, _| {
                if env
                    .call_method(
                        activity,
                        "setBarAppearance",
                        "(Z)V",
                        &[jni::objects::JValue::Bool(u8::from(dark))],
                    )
                    .is_err()
                {
                    // A host without the override keeps its platform appearance.
                    let _ = env.exception_clear();
                }
            });
        });
    });
}
