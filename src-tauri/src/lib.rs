// The application shell.
//
// Everything the planner does happens in the webview: the app is a static SPA that
// keeps its projects in the webview's own local storage, and the Rust side owns the
// window and the bundle. There is deliberately no command surface here yet — the
// template's `greet` was removed with the template — because native file open/save and
// an update channel are the next things to arrive, and they will show up as commands
// in this file.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
