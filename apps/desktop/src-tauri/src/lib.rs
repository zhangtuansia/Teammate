use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    sync::Mutex,
    time::Duration,
};
use tauri::Manager;
use tauri_plugin_shell::{process::CommandChild, process::CommandEvent, ShellExt};

struct RuntimeProcess(Mutex<Option<CommandChild>>);

fn local_runtime_available() -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], 8787));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(150)) else {
        return false;
    };

    let timeout = Some(Duration::from_millis(300));
    let _ = stream.set_read_timeout(timeout);
    let _ = stream.set_write_timeout(timeout);

    if stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1:8787\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }

    let mut response = String::new();
    stream.read_to_string(&mut response).is_ok()
        && response.contains("\"ok\":true")
        && response.contains("\"mode\":\"local\"")
}

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
            if local_runtime_available() {
                eprintln!("[runtime] reusing local service on 127.0.0.1:8787");
                app.manage(RuntimeProcess(Mutex::new(None)));
                return Ok(());
            }

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
