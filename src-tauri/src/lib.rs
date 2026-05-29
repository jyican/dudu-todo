use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, PhysicalPosition,
};
use tauri_plugin_notification::NotificationExt;

/// Minimal mirror of the frontend todo schema — we only need enough to count
/// pending items and list their titles in the reminder notification.
#[derive(Deserialize)]
struct Todo {
    #[serde(default)]
    text: String,
    #[serde(default)]
    done: bool,
}

/// Path to the JSON store, e.g. ~/Library/Application Support/<id>/todos.json
fn store_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("todos.json"))
}

#[tauri::command]
fn load_todos(app: tauri::AppHandle) -> Result<String, String> {
    let path = store_path(&app)?;
    match fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        // First launch: no file yet → empty list.
        Err(_) => Ok("[]".to_string()),
    }
}

#[tauri::command]
fn save_todos(app: tauri::AppHandle, data: String) -> Result<(), String> {
    let path = store_path(&app)?;
    fs::write(&path, data).map_err(|e| e.to_string())
}

/// Write arbitrary text to a user-chosen path (used by the export feature).
#[tauri::command]
fn save_text(path: String, data: String) -> Result<(), String> {
    fs::write(&path, data).map_err(|e| e.to_string())
}

// ---- Local agent CLI integration (Claude Code / Codex) ----

#[derive(Serialize)]
struct AgentReply {
    text: String,
    session_id: String,
}

fn home_dir() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/".into())
}

/// Run a command through a login shell so the user's full PATH is available
/// (bundled GUI apps don't inherit homebrew / ~/.local/bin otherwise).
fn login_shell(script: &str, cwd: &str, prompt: &str) -> Result<std::process::Output, String> {
    let dir = if cwd.trim().is_empty() { home_dir() } else { cwd.to_string() };
    Command::new("/bin/zsh")
        .arg("-lc")
        .arg(script)
        .current_dir(dir)
        .env("FT_PROMPT", prompt) // prompt passed via env → no shell-quoting issues
        .output()
        .map_err(|e| e.to_string())
}

/// Whether the given engine's CLI is installed and reachable on PATH.
#[tauri::command]
fn agent_available(engine: String) -> bool {
    let bin = if engine == "codex" { "codex" } else { "claude" };
    login_shell(&format!("command -v {bin}"), "", "")
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Send a prompt to the local agent CLI and return its reply (+ session id for
/// multi-turn continuation). Skills are loaded by the CLI from the user's own
/// machine (cwd project + ~/.claude).
#[tauri::command]
fn ask_agent(
    engine: String,
    prompt: String,
    cwd: String,
    session_id: String,
    resume: bool,
    permission_mode: String,
) -> Result<AgentReply, String> {
    if engine == "codex" {
        // Codex: single-shot non-interactive. (Multi-turn TBD.)
        let out = login_shell("codex exec \"$FT_PROMPT\"", &cwd, &prompt)?;
        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        if !out.status.success() {
            return Err(if stderr.is_empty() { stdout } else { stderr });
        }
        return Ok(AgentReply {
            text: stdout.trim().to_string(),
            session_id: String::new(),
        });
    }

    // Claude Code: JSON output carries the result text + session id.
    let mode = match permission_mode.as_str() {
        "bypassPermissions" | "acceptEdits" | "plan" | "default" | "dontAsk" | "auto" => {
            permission_mode.as_str()
        }
        _ => "acceptEdits",
    };
    let session_flag = if resume {
        format!("--resume {session_id}")
    } else {
        format!("--session-id {session_id}")
    };
    let script = format!(
        "printf '%s' \"$FT_PROMPT\" | claude -p --output-format json --permission-mode {mode} {session_flag}"
    );
    let out = login_shell(&script, &cwd, &prompt)?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    if !out.status.success() && stdout.trim().is_empty() {
        return Err(if stderr.is_empty() {
            "agent 调用失败(claude 未登录或不可用?)".into()
        } else {
            stderr
        });
    }

    let v: serde_json::Value =
        serde_json::from_str(stdout.trim()).map_err(|e| format!("解析回复失败: {e}\n{stdout}"))?;
    if v.get("is_error").and_then(|b| b.as_bool()).unwrap_or(false) {
        return Err(v
            .get("result")
            .and_then(|r| r.as_str())
            .unwrap_or("agent 返回错误")
            .to_string());
    }
    let text = v
        .get("result")
        .and_then(|r| r.as_str())
        .unwrap_or("")
        .to_string();
    let sid = v
        .get("session_id")
        .and_then(|r| r.as_str())
        .unwrap_or(&session_id)
        .to_string();
    Ok(AgentReply {
        text,
        session_id: sid,
    })
}

/// The default working directory for the agent (user home).
#[tauri::command]
fn default_cwd() -> String {
    home_dir()
}

/// The app's own version (from Cargo.toml), used by the update check.
#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Open a URL in the user's default browser (for the "download update" link).
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("open");
        c.arg(&url);
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = Command::new("cmd");
        c.args(["/C", "start", "", &url]);
        c
    };
    #[cfg(target_os = "linux")]
    let mut cmd = {
        let mut c = Command::new("xdg-open");
        c.arg(&url);
        c
    };
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Read the store and send one notification summarising pending todos.
fn notify_pending(app: &tauri::AppHandle) {
    let Ok(path) = store_path(app) else { return };
    let Ok(raw) = fs::read_to_string(&path) else { return };
    let Ok(todos) = serde_json::from_str::<Vec<Todo>>(&raw) else { return };

    let pending: Vec<&Todo> = todos.iter().filter(|t| !t.done).collect();
    if pending.is_empty() {
        return;
    }

    // Show up to 5 titles so the notification stays readable.
    let mut lines: Vec<String> = pending
        .iter()
        .take(5)
        .map(|t| format!("• {}", t.text))
        .collect();
    if pending.len() > 5 {
        lines.push(format!("…还有 {} 项", pending.len() - 5));
    }

    let _ = app
        .notification()
        .builder()
        .title(format!("你有 {} 项待办未完成", pending.len()))
        .body(lines.join("\n"))
        .show();
}

/// Reminder cadence. Defaults to 3 hours; override with TODO_INTERVAL_SECS
/// (handy for testing, e.g. TODO_INTERVAL_SECS=20).
fn interval_secs() -> u64 {
    std::env::var("TODO_INTERVAL_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|&n| n > 0)
        .unwrap_or(3 * 60 * 60)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            load_todos,
            save_todos,
            save_text,
            agent_available,
            ask_agent,
            default_cwd,
            app_version,
            open_url
        ])
        .setup(|app| {
            // --- System tray: show/quit, keep app alive after window close ---
            let show = MenuItem::with_id(app, "show", "显示", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("dudu tools")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            // --- Default position: top-right of the primary screen, topmost ---
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_always_on_top(true);
                if let Ok(Some(monitor)) = win.primary_monitor() {
                    let scale = monitor.scale_factor();
                    let msize = monitor.size();
                    let mpos = monitor.position();
                    let wsize = win.outer_size().unwrap_or(tauri::PhysicalSize::new(
                        (120.0 * scale) as u32,
                        (120.0 * scale) as u32,
                    ));
                    let margin_x = (16.0 * scale) as i32;
                    let margin_top = (44.0 * scale) as i32; // clear the menu bar
                    let x = mpos.x + msize.width as i32 - wsize.width as i32 - margin_x;
                    let y = mpos.y + margin_top;
                    let _ = win.set_position(PhysicalPosition::new(x, y));
                }
            }

            // --- Background reminder loop (runs even while window is hidden) ---
            let handle = app.handle().clone();
            let secs = interval_secs();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(secs));
                notify_pending(&handle);
            });

            Ok(())
        })
        // Intercept window close → hide to tray instead of quitting, so the
        // 3-hour reminder keeps running in the background.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
