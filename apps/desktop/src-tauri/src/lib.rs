use std::{
    fmt::Write as _,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use tauri::Manager;
use tauri_plugin_shell::{process::CommandChild, process::CommandEvent, ShellExt};

const SIDECAR_SHUTDOWN_COMMAND: &[u8] = b"teammate:shutdown\n";
const SIDECAR_SHUTDOWN_POLL_INTERVAL: Duration = Duration::from_millis(100);
const SIDECAR_SHUTDOWN_POLL_ATTEMPTS: usize = 120;
#[cfg(debug_assertions)]
const LOCAL_SERVER_PORT: &str = "8788";
#[cfg(not(debug_assertions))]
const LOCAL_SERVER_PORT: &str = "8787";

struct RuntimeProcess {
    child: Mutex<Option<CommandChild>>,
    terminated: Arc<AtomicBool>,
}
struct LocalControllerCredential(String);
struct AppLifecycle {
    setup_complete: AtomicBool,
}

fn focus_or_create_main_window(app: &tauri::AppHandle) {
    let window = app.get_webview_window("main").or_else(|| {
        let lifecycle = app.try_state::<AppLifecycle>()?;
        if !lifecycle.setup_complete.load(Ordering::Acquire) {
            return None;
        }
        let config = app
            .config()
            .app
            .windows
            .iter()
            .find(|config| config.label == "main")?;
        match tauri::WebviewWindowBuilder::from_config(app, config)
            .and_then(|builder| builder.build())
        {
            Ok(window) => {
                configure_main_window_close(&window);
                ensure_window_on_screen(&window);
                Some(window)
            }
            Err(error) => {
                eprintln!("Could not restore the Teammate window: {error}");
                None
            }
        }
    });

    if let Some(window) = window {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Restored window positions can land entirely off-screen (a disconnected
/// display, or stale saved state). Re-center the window when no monitor
/// contains its title-bar area, so the app never launches invisible.
fn ensure_window_on_screen(window: &tauri::WebviewWindow) {
    let Ok(position) = window.outer_position() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    let Ok(monitors) = window.available_monitors() else {
        return;
    };
    let probe_x = position.x + (size.width as i32) / 2;
    let probe_y = position.y + 20;
    let visible = monitors.iter().any(|monitor| {
        let origin = monitor.position();
        let extent = monitor.size();
        probe_x >= origin.x
            && probe_x < origin.x + extent.width as i32
            && probe_y >= origin.y
            && probe_y < origin.y + extent.height as i32
    });
    if !visible {
        let _ = window.center();
    }
}

#[cfg(target_os = "macos")]
fn configure_main_window_close(window: &tauri::WebviewWindow) {
    let window_to_hide = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = window_to_hide.hide();
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn configure_main_window_close(_window: &tauri::WebviewWindow) {}

fn generate_controller_credential() -> String {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).expect("operating system randomness is unavailable");
    let mut credential = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut credential, "{byte:02x}").expect("writing to a string cannot fail");
    }
    credential
}

#[tauri::command]
fn local_controller_credential(credential: tauri::State<'_, LocalControllerCredential>) -> String {
    credential.0.clone()
}

impl Drop for RuntimeProcess {
    fn drop(&mut self) {
        let Ok(mut process) = self.child.lock() else {
            return;
        };
        let Some(mut child) = process.take() else {
            return;
        };
        drop(process);

        if child.write(SIDECAR_SHUTDOWN_COMMAND).is_ok() {
            for _ in 0..SIDECAR_SHUTDOWN_POLL_ATTEMPTS {
                if self.terminated.load(Ordering::Acquire) {
                    return;
                }
                thread::sleep(SIDECAR_SHUTDOWN_POLL_INTERVAL);
            }
        }
        let _ = child.kill();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let controller_credential = generate_controller_credential();
    let mut builder = tauri::Builder::default();
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            focus_or_create_main_window(app);
        }));
    }

    builder
        .manage(AppLifecycle {
            setup_complete: AtomicBool::new(false),
        })
        .manage(LocalControllerCredential(controller_credential))
        .invoke_handler(tauri::generate_handler![local_controller_credential])
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let controller_credential = app.state::<LocalControllerCredential>().0.clone();

            let data_dir_arg = data_dir.to_string_lossy().into_owned();
            let command = app
                .shell()
                .sidecar("teammate-runtime")?
                .args([
                    "--data-dir".to_string(),
                    data_dir_arg,
                    "--port".to_string(),
                    LOCAL_SERVER_PORT.to_string(),
                ])
                .env("TEAMMATE_LOCAL_CONTROLLER_TOKEN", controller_credential);
            let (mut events, child) = command.spawn()?;
            let runtime_terminated = Arc::new(AtomicBool::new(false));
            let event_terminated = Arc::clone(&runtime_terminated);

            tauri::async_runtime::spawn(async move {
                while let Some(event) = events.recv().await {
                    match event {
                        CommandEvent::Stdout(bytes) => {
                            println!("[runtime] {}", String::from_utf8_lossy(&bytes));
                        }
                        CommandEvent::Stderr(bytes) => {
                            eprintln!("[runtime] {}", String::from_utf8_lossy(&bytes));
                        }
                        CommandEvent::Error(error) => {
                            eprintln!("[runtime] {error}");
                        }
                        CommandEvent::Terminated(payload) => {
                            event_terminated.store(true, Ordering::Release);
                            eprintln!("[runtime] exited: {:?}", payload.code);
                        }
                        _ => {}
                    }
                }
                event_terminated.store(true, Ordering::Release);
            });

            app.manage(RuntimeProcess {
                child: Mutex::new(Some(child)),
                terminated: runtime_terminated,
            });
            if let Some(window) = app.get_webview_window("main") {
                configure_main_window_close(&window);
                ensure_window_on_screen(&window);
            }
            app.state::<AppLifecycle>()
                .setup_complete
                .store(true, Ordering::Release);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Teammate desktop")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } = event
            {
                focus_or_create_main_window(app);
            }
        });
}
