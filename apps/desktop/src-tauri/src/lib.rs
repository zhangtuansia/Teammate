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
// The graceful handshake normally lands within one poll. The bound only
// matters when the sidecar is wedged, and a wedged quit should not hold the
// window hostage — kill after a few seconds rather than twelve.
const SIDECAR_SHUTDOWN_POLL_ATTEMPTS: usize = 50;
#[cfg(debug_assertions)]
const LOCAL_SERVER_PORT: &str = "8788";
#[cfg(not(debug_assertions))]
const LOCAL_SERVER_PORT: &str = "8787";

#[cfg(target_os = "macos")]
const SIDECAR_NAMES: [&str; 3] = ["teammate-runtime", "teammate-cli", "teammate-pi"];

/// Executables inside an app's `Contents/MacOS` directory inherit that app's
/// foreground LaunchServices identity on newer macOS versions. Stage the
/// headless sidecars in the app cache so they remain ordinary background
/// processes instead of appearing as a second generic `exec` Dock icon.
#[cfg(target_os = "macos")]
fn stage_macos_sidecars(
    source_dir: &std::path::Path,
    cache_dir: &std::path::Path,
) -> std::io::Result<std::path::PathBuf> {
    let stage_dir = cache_dir.join("sidecars");
    std::fs::create_dir_all(&stage_dir)?;

    let mut stamp = String::new();
    for name in SIDECAR_NAMES {
        let metadata = std::fs::metadata(source_dir.join(name))?;
        let modified = metadata
            .modified()?
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        writeln!(&mut stamp, "{name}:{}:{modified}", metadata.len())
            .expect("writing a sidecar stamp to a string cannot fail");
    }

    let stamp_path = stage_dir.join("build.stamp");
    let staged_files_exist = SIDECAR_NAMES
        .iter()
        .all(|name| stage_dir.join(name).is_file());
    let stamp_matches =
        std::fs::read_to_string(&stamp_path).ok().as_deref() == Some(stamp.as_str());

    if !staged_files_exist || !stamp_matches {
        for name in SIDECAR_NAMES {
            let source = source_dir.join(name);
            let destination = stage_dir.join(name);
            let temporary = stage_dir.join(format!(".{name}.tmp"));
            let _ = std::fs::remove_file(&temporary);
            std::fs::copy(&source, &temporary)?;
            std::fs::set_permissions(&temporary, std::fs::metadata(&source)?.permissions())?;
            std::fs::rename(&temporary, destination)?;
        }
        let temporary_stamp = stage_dir.join(".build.stamp.tmp");
        std::fs::write(&temporary_stamp, &stamp)?;
        std::fs::rename(temporary_stamp, stamp_path)?;
    }

    Ok(stage_dir.join("teammate-runtime"))
}

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
                configure_main_window(&window);
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

/// A restored window frame can land entirely off-screen — a display that is no
/// longer attached, or saved state that was already off-screen and keeps
/// restoring itself there. Recenter only when the frame overlaps no monitor at
/// all, so a window the user deliberately parked half off the edge is left
/// alone.
fn ensure_window_on_screen(window: &tauri::WebviewWindow) {
    let (Ok(position), Ok(size), Ok(monitors)) = (
        window.outer_position(),
        window.outer_size(),
        window.available_monitors(),
    ) else {
        return;
    };
    let left = position.x;
    let top = position.y;
    let right = left + size.width as i32;
    let bottom = top + size.height as i32;
    let intersects_a_monitor = monitors.iter().any(|monitor| {
        let origin = monitor.position();
        let extent = monitor.size();
        left < origin.x + extent.width as i32
            && right > origin.x
            && top < origin.y + extent.height as i32
            && bottom > origin.y
    });
    if !intersects_a_monitor {
        let _ = window.center();
    }
}

/// The frame is restored by the OS after `setup` runs, so the off-screen check
/// has to react to the move rather than sample the position once at startup.
fn configure_main_window(window: &tauri::WebviewWindow) {
    let observed = window.clone();
    window.on_window_event(move |event| match event {
        #[cfg(target_os = "macos")]
        tauri::WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let _ = observed.hide();
        }
        tauri::WindowEvent::Moved(_) => ensure_window_on_screen(&observed),
        _ => {}
    });
    ensure_window_on_screen(window);
}

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
            #[cfg(target_os = "macos")]
            let command = {
                let executable = std::env::current_exe()?;
                let executable_dir = executable.parent().ok_or_else(|| {
                    std::io::Error::new(
                        std::io::ErrorKind::NotFound,
                        "Teammate executable directory is unavailable",
                    )
                })?;
                let runtime =
                    stage_macos_sidecars(executable_dir, &app.path().app_cache_dir()?)?;
                app.shell().command(runtime)
            };
            #[cfg(not(target_os = "macos"))]
            let command = app.shell().sidecar("teammate-runtime")?;
            let command = command
                .args([
                    "--data-dir".to_string(),
                    data_dir_arg,
                    "--port".to_string(),
                    LOCAL_SERVER_PORT.to_string(),
                ])
                .env(
                    "TEAMMATE_LOCAL_CONTROLLER_TOKEN",
                    controller_credential.clone(),
                );
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
                // The command remains the normal credential path. Injecting the
                // same renderer-scoped value also covers WebKit occasionally
                // delaying the first invoke while the app is restoring a window.
                // Without this fallback React never mounts and the window stays
                // blank even though the local runtime is already healthy.
                let credential_script = format!(
                    "window.__TEAMMATE_LOCAL_CONTROLLER_CREDENTIAL__='{controller_credential}';window.dispatchEvent(new Event('teammate:local-controller-credential'));"
                );
                if let Err(error) = window.eval(&credential_script) {
                    eprintln!("Could not inject the local controller credential: {error}");
                }
                configure_main_window(&window);
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
