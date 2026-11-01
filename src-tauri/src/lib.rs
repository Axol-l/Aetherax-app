// The application shell.
//
// Everything the planner does happens in the webview: the app is a static SPA that
// keeps its projects in the webview's own local storage, and the Rust side owns the
// window and the bundle. There is deliberately almost no command surface here yet —
// native file open/save and an update channel are the next things to arrive, and they
// will show up as commands in this file.
//
// The one thing the shell does have to own is *when the window goes away*, because the
// page cannot: see `on_window_event` below.

use std::time::Duration;
use tauri::Emitter;

/// How long the page gets between "the window is closing" and the window going away.
///
/// Long enough for a listener to run — the page's handler is a synchronous write — and
/// short enough that a page which never answers cannot leave a window nobody can close.
const CLOSE_GRACE: Duration = Duration::from_millis(250);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                /*
                 * The planner keeps its project in the webview's own storage and writes it
                 * on a five-second debounce, so a close inside that window used to lose the
                 * last edit: destroying the webview destroys the pending write with it, and
                 * `pagehide` is not something a destroyed webview reliably gets to run.
                 *
                 * So the close is deferred and the page is told. It is *not* "wait for the
                 * page to say it is done": the window is destroyed either way after the
                 * grace period, because a page that throws or hangs must never leave the
                 * user with a window that will not close.
                 */
                api.prevent_close();
                let window = window.clone();
                let _ = window.emit("flush-before-close", ());
                std::thread::spawn(move || {
                    std::thread::sleep(CLOSE_GRACE);
                    let _ = window.destroy();
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
