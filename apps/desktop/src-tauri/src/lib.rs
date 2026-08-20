use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_shell::{process::CommandChild, process::CommandEvent, ShellExt};

struct RuntimeProcess(Mutex<Option<CommandChild>>);

impl Drop for RuntimeProcess {
    fn drop(&mut self) {
        if let Ok(mut process) = self.0.lock() {
            if let Some(child) = process.take() {
                let _ = child.kill();
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;

            let data_dir_arg = data_dir.to_string_lossy().into_owned();
            let command = app
                .shell()
                .sidecar("teammate-runtime")?
                .args(["--data-dir".to_string(), data_dir_arg]);
            let (mut events, child) = command.spawn()?;

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
                            eprintln!("[runtime] exited: {:?}", payload.code);
                        }
                        _ => {}
                    }
                }
            });

            app.manage(RuntimeProcess(Mutex::new(Some(child))));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Teammate desktop");
}
