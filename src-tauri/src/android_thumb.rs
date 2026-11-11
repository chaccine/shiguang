//! Bridge native decoding to a worker attached to the JVM, never decode on WebView thread.
use std::{path::Path, sync::mpsc, time::Duration};
pub fn generate(window: tauri::WebviewWindow, source: &Path, target: &Path) -> Result<(), String> {
    let (tx, rx) = mpsc::channel();
    let source = source.to_string_lossy().into_owned();
    let target = target.to_string_lossy().into_owned();
    window
        .with_webview(move |webview| {
            webview.jni_handle().exec(move |env, activity, _| {
                let setup = env
                    .get_java_vm()
                    .and_then(|vm| env.new_global_ref(activity).map(|activity| (vm, activity)));
                match setup {
                    Err(e) => {
                        let _ = tx.send(Err(e.to_string()));
                    }
                    Ok((vm, activity)) => {
                        std::thread::spawn(move || {
                            let result = (|| -> Result<(), String> {
                                let mut env =
                                    vm.attach_current_thread().map_err(|e| e.to_string())?;
                                let a = env.new_string(source).map_err(|e| e.to_string())?;
                                let b = env.new_string(target).map_err(|e| e.to_string())?;
                                let ok = env
                                    .call_method(
                                        activity.as_obj(),
                                        "decodeThumbnail",
                                        "(Ljava/lang/String;Ljava/lang/String;)Z",
                                        &[
                                            jni::objects::JValue::Object(a.as_ref()),
                                            jni::objects::JValue::Object(b.as_ref()),
                                        ],
                                    )
                                    .and_then(|v| v.z())
                                    .map_err(|e| e.to_string())?;
                                if ok {
                                    Ok(())
                                } else {
                                    Err("native decode unavailable".into())
                                }
                            })();
                            let _ = tx.send(result);
                        });
                    }
                }
            });
        })
        .map_err(|e| e.to_string())?;
    rx.recv_timeout(Duration::from_secs(15))
        .map_err(|e| e.to_string())?
}
