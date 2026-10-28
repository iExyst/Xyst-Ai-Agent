#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rfd::FileDialog;
use serde::Deserialize;
use serde::Serialize;
use std::env;
use std::ffi::{OsStr, OsString};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{
    Manager, PhysicalPosition, PhysicalSize, RunEvent, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};
use url::Url;

#[cfg(windows)]
mod system_proxy;
#[cfg(windows)]
pub mod windows_sandbox;

const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(8);
const MIN_WINDOW_WIDTH: u32 = 760;
const MIN_WINDOW_HEIGHT: u32 = 540;
static NEXT_STATE_TEMP_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

struct LaunchOptions {
    workspace: Option<PathBuf>,
    config: Option<PathBuf>,
}

struct DesktopService {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct WindowBounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    #[serde(default)]
    maximized: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct LastWorkspace {
    path: String,
}

const MAX_WORKSPACE_STATE_BYTES: u64 = 32 * 1024;
const MAX_SESSION_STATE_BYTES: u64 = 1024;
const TEST_APP_DIRECTORIES_ROOT_ENV: &str = "XYST_TEST_APP_DIRECTORIES_ROOT";

impl WindowBounds {
    fn valid_size(self) -> bool {
        (MIN_WINDOW_WIDTH..=8192).contains(&self.width)
            && (MIN_WINDOW_HEIGHT..=8192).contains(&self.height)
    }

    fn visible_on(self, window: &WebviewWindow) -> bool {
        let Ok(monitors) = window.available_monitors() else {
            return false;
        };
        let left = i64::from(self.x);
        let top = i64::from(self.y);
        let right = left + i64::from(self.width);
        let bottom = top + i64::from(self.height);
        monitors.iter().any(|monitor| {
            let position = monitor.position();
            let size = monitor.size();
            let mx = i64::from(position.x);
            let my = i64::from(position.y);
            let mr = mx + i64::from(size.width);
            let mb = my + i64::from(size.height);
            left < mr && right > mx && top < mb && bottom > my
        })
    }
}

fn bounds_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("window-state.json"))
}

fn workspace_history_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("last-workspace.json"))
}

fn last_session_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("last-session.json"))
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct LastSession {
    id: String,
}

fn valid_session_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    bytes.len() == 36
        && [8, 13, 18, 23].iter().all(|&i| bytes[i] == b'-')
        && bytes
            .iter()
            .enumerate()
            .all(|(i, b)| [8, 13, 18, 23].contains(&i) || b.is_ascii_hexdigit())
}

fn restore_last_session(state_path: &Path) -> Option<String> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(state_path).ok()?;
    let opened = file.metadata().ok()?;
    if !opened.is_file() || opened.len() > MAX_SESSION_STATE_BYTES {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if opened.nlink() != 1 {
            return None;
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        if opened.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || windows_link_count(&file)? != 1
        {
            return None;
        }
    }
    let mut bytes = Vec::with_capacity(opened.len() as usize);
    file.take(MAX_SESSION_STATE_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 != opened.len() || bytes.len() as u64 > MAX_SESSION_STATE_BYTES {
        return None;
    }
    let state = serde_json::from_slice::<LastSession>(&bytes).ok()?;
    valid_session_id(&state.id).then_some(state.id)
}

#[tauri::command]
fn get_last_session(app: tauri::AppHandle) -> Option<String> {
    restore_last_session(&last_session_path(&app)?)
}

#[tauri::command]
fn set_last_session(app: tauri::AppHandle, id: Option<String>) -> Result<(), String> {
    let path =
        last_session_path(&app).ok_or_else(|| "App config directory is unavailable".to_owned())?;
    match id {
        Some(id) if valid_session_id(&id) => {
            let bytes =
                serde_json::to_vec(&LastSession { id }).map_err(|error| error.to_string())?;
            write_atomic_bytes(&path, &bytes).map_err(|error| error.to_string())
        }
        Some(_) => Err("Session ID must be a UUID".to_owned()),
        None => match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        },
    }
}

fn restore_last_workspace(state_path: &Path) -> Option<PathBuf> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(state_path).ok()?;
    let opened = file.metadata().ok()?;
    if !opened.is_file() || opened.len() > MAX_WORKSPACE_STATE_BYTES {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if opened.nlink() != 1 {
            return None;
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        if opened.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || windows_link_count(&file)? != 1
        {
            return None;
        }
    }
    let mut bytes = Vec::with_capacity(opened.len() as usize);
    file.take(MAX_WORKSPACE_STATE_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 != opened.len() || bytes.len() as u64 > MAX_WORKSPACE_STATE_BYTES {
        return None;
    }
    let state = serde_json::from_slice::<LastWorkspace>(&bytes).ok()?;
    canonical_directory(Path::new(&state.path)).ok()
}

#[cfg(windows)]
fn windows_link_count(file: &std::fs::File) -> Option<u32> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };

    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) } == 0 {
        None
    } else {
        Some(information.nNumberOfLinks)
    }
}

fn save_last_workspace(state_path: &Path, workspace: &Path) {
    let Ok(workspace) = canonical_directory(workspace) else {
        return;
    };
    let Some(workspace) = workspace.to_str() else {
        return;
    };
    let state = LastWorkspace {
        path: workspace.to_owned(),
    };
    let Ok(bytes) = serde_json::to_vec(&state) else {
        return;
    };
    let _ = write_atomic_bytes(state_path, &bytes);
}

fn restore_window_bounds(window: &WebviewWindow, path: &Path) {
    let Ok(bytes) = std::fs::read(path) else {
        return;
    };
    let Ok(bounds) = serde_json::from_slice::<WindowBounds>(&bytes) else {
        return;
    };
    if !bounds.valid_size() || !bounds.visible_on(window) {
        return;
    }
    let _ = window.set_size(PhysicalSize::new(bounds.width, bounds.height));
    let _ = window.set_position(PhysicalPosition::new(bounds.x, bounds.y));
    if bounds.maximized {
        let _ = window.maximize();
    }
}

fn save_window_bounds(window: &WebviewWindow, path: &Path) {
    let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) else {
        return;
    };
    let maximized = window.is_maximized().unwrap_or(false);
    let bounds = WindowBounds {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        maximized,
    };
    if !bounds.valid_size() {
        return;
    }
    let _ = write_window_bounds(path, bounds);
}

fn write_window_bounds(path: &Path, bounds: WindowBounds) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(&bounds)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    write_atomic_bytes(path, &bytes)
}

fn write_atomic_bytes(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let Some(parent) = path.parent() else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "state path has no parent directory",
        ));
    };
    std::fs::create_dir_all(parent)?;
    let (temporary, mut file) = create_state_temporary(path, parent)?;
    let result = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        replace_file(&temporary, path)?;
        sync_parent_directory(parent)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

fn create_state_temporary(path: &Path, parent: &Path) -> std::io::Result<(PathBuf, std::fs::File)> {
    let name = path
        .file_name()
        .unwrap_or_else(|| OsStr::new("state"))
        .to_string_lossy();
    for _ in 0..32 {
        let sequence = NEXT_STATE_TEMP_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let temporary = parent.join(format!(".{name}.{}.{}.tmp", std::process::id(), sequence));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&temporary) {
            Ok(file) => return Ok((temporary, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "could not allocate a unique state temporary file",
    ))
}

#[cfg(unix)]
fn sync_parent_directory(parent: &Path) -> std::io::Result<()> {
    std::fs::File::open(parent)?.sync_all()
}

#[cfg(not(unix))]
fn sync_parent_directory(_parent: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    std::fs::rename(source, destination)
}

#[derive(Deserialize)]
struct Bootstrap {
    url: String,
    token: String,
    api_version: u32,
}

impl DesktopService {
    fn request_shutdown(&self) {
        if let Ok(mut stdin) = self.stdin.lock() {
            if let Some(mut input) = stdin.take() {
                let _ = input.write_all(b"xyst-desktop-shutdown\n");
                let _ = input.flush();
            }
        }
        let child = self.child.lock().ok().and_then(|mut child| child.take());
        if let Some(mut child) = child {
            thread::spawn(move || {
                let deadline = Instant::now() + SHUTDOWN_TIMEOUT;
                loop {
                    match child.try_wait() {
                        Ok(Some(_)) => return,
                        Ok(None) if Instant::now() < deadline => {
                            thread::sleep(Duration::from_millis(100))
                        }
                        _ => {
                            let _ = child.kill();
                            let _ = child.wait();
                            return;
                        }
                    }
                }
            });
        }
    }
}

impl Drop for DesktopService {
    fn drop(&mut self) {
        self.request_shutdown();
    }
}

fn main() {
    let arguments = env::args_os().skip(1).collect::<Vec<_>>();
    if arguments
        .first()
        .is_some_and(|arg| arg == OsStr::new("--capture-screen"))
    {
        if arguments.len() != 1 {
            eprintln!("xyst-desktop: --capture-screen takes no additional arguments");
            std::process::exit(2);
        }
        #[cfg(windows)]
        {
            match capture_screen_json() {
                Ok(json) => println!("{json}"),
                Err(error) => {
                    eprintln!("xyst-desktop: screen capture failed: {error}");
                    std::process::exit(1);
                }
            }
            return;
        }
        #[cfg(not(windows))]
        {
            eprintln!("xyst-desktop: native screen capture is available only on Windows");
            std::process::exit(2);
        }
    }
    let options = match parse_args(arguments.into_iter()) {
        Ok(options) => options,
        Err(message) => {
            eprintln!("xyst-desktop: {message}");
            std::process::exit(2);
        }
    };
    let launch_workspace = options.workspace;
    let config = options.config.map(|path| absolute_path(&path));
    let mut context = tauri::generate_context!();
    let app_directories_root =
        match test_app_directories_root(env::var_os(TEST_APP_DIRECTORIES_ROOT_ENV)) {
            Ok(root) => root,
            Err(message) => {
                eprintln!("xyst-desktop: {message}");
                std::process::exit(2);
            }
        };
    if let Some(root) = app_directories_root {
        context.config_mut().app.app_directories_override =
            Some(tauri::utils::config::AppDirectoriesOverride::Root(root));
    }
    let result = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![get_last_session, set_last_session])
        .setup(move |app| {
            let workspace = if let Some(path) = launch_workspace.as_deref() {
                match canonical_directory(path) {
                    Ok(path) => path,
                    Err(error) => return Err(error),
                }
            } else if let Some(path) =
                workspace_history_path(app.handle()).and_then(|path| restore_last_workspace(&path))
            {
                path
            } else {
                let Some(path) = FileDialog::new()
                    .set_title("Choose a Xyst AI Assistant workspace")
                    .pick_folder()
                else {
                    app.handle().exit(0);
                    return Ok(());
                };
                canonical_directory(&path)?
            };
            if let Some(path) = workspace_history_path(app.handle()) {
                save_last_workspace(&path, &workspace);
            }
            let cli = resolve_cli(app.handle())?;
            let node = resolve_node(app.handle());
            verify_node(&node)?;
            let (child, input, bootstrap_line) =
                start_service(&node, &cli, &workspace, config.as_deref())?;
            let url = match validate_bootstrap(bootstrap_line) {
                Ok(url) => url,
                Err(error) => {
                    let mut child = child;
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(error);
                }
            };
            app.manage(DesktopService {
                child: Mutex::new(Some(child)),
                stdin: Mutex::new(Some(input)),
            });
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("Xyst AI Assistant")
                .inner_size(1440.0, 920.0)
                .min_inner_size(f64::from(MIN_WINDOW_WIDTH), f64::from(MIN_WINDOW_HEIGHT))
                .center()
                .resizable(true)
                .build()?;
            let state_path = bounds_path(app.handle());
            if let Some(path) = &state_path {
                restore_window_bounds(&window, path);
                save_window_bounds(&window, path);
            }
            if let Some(path) = state_path {
                let tracked_window = window.clone();
                window.on_window_event(move |event| {
                    if matches!(
                        event,
                        WindowEvent::Moved(_)
                            | WindowEvent::Resized(_)
                            | WindowEvent::CloseRequested { .. }
                    ) {
                        save_window_bounds(&tracked_window, &path);
                    }
                });
            }
            window.set_focus()?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::CloseRequested { .. }) {
                if let Some(service) = window.try_state::<DesktopService>() {
                    service.request_shutdown();
                }
            }
        })
        .build(context);

    match result {
        Ok(app) => {
            app.run(|handle, event| match event {
                RunEvent::ExitRequested { .. } => {
                    if let (Some(window), Some(path)) =
                        (handle.get_webview_window("main"), bounds_path(handle))
                    {
                        save_window_bounds(&window, &path);
                    }
                }
                RunEvent::Exit => {
                    if let Some(service) = handle.try_state::<DesktopService>() {
                        service.request_shutdown();
                    }
                }
                _ => {}
            });
        }
        Err(error) => {
            eprintln!("xyst-desktop: failed to start: {error}");
            std::process::exit(1);
        }
    }
}

fn test_app_directories_root(value: Option<OsString>) -> Result<Option<PathBuf>, &'static str> {
    let Some(value) = value else {
        return Ok(None);
    };
    let root = PathBuf::from(value);
    if !root.is_absolute() {
        return Err("XYST_TEST_APP_DIRECTORIES_ROOT must be an absolute path");
    }
    Ok(Some(root))
}

#[cfg(windows)]
fn capture_screen_json() -> Result<String, Box<dyn std::error::Error>> {
    use base64::Engine;
    use std::ffi::c_void;
    use std::ptr::{null_mut, NonNull};
    use windows_sys::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
        HBITMAP, HDC, HGDIOBJ, SRCCOPY,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
        SM_YVIRTUALSCREEN,
    };

    let left = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
    let top = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
    let width = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) };
    let height = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) };
    if width <= 0 || height <= 0 || i64::from(width) * i64::from(height) > 24_000_000 {
        return Err("virtual desktop dimensions exceed the screenshot limit".into());
    }

    let screen_dc = unsafe { GetDC(null_mut()) };
    let screen_dc = NonNull::new(screen_dc).ok_or("could not open the desktop device context")?;
    let memory_dc = unsafe { CreateCompatibleDC(screen_dc.as_ptr()) };
    let memory_dc = match NonNull::new(memory_dc) {
        Some(dc) => dc,
        None => {
            unsafe { ReleaseDC(null_mut(), screen_dc.as_ptr()) };
            return Err("could not create a desktop capture context".into());
        }
    };
    let bitmap = unsafe { CreateCompatibleBitmap(screen_dc.as_ptr(), width, height) };
    let bitmap = match NonNull::new(bitmap) {
        Some(bitmap) => bitmap,
        None => {
            unsafe {
                DeleteDC(memory_dc.as_ptr());
                ReleaseDC(null_mut(), screen_dc.as_ptr());
            }
            return Err("could not allocate a desktop capture image".into());
        }
    };

    let result = (|| -> Result<String, Box<dyn std::error::Error>> {
        let old_bitmap = unsafe { SelectObject(memory_dc.as_ptr(), bitmap.as_ptr() as HGDIOBJ) };
        if old_bitmap.is_null() || old_bitmap as isize == -1 {
            return Err("could not select the desktop capture image".into());
        }
        let copied = unsafe {
            BitBlt(
                memory_dc.as_ptr(),
                0,
                0,
                width,
                height,
                screen_dc.as_ptr(),
                left,
                top,
                SRCCOPY,
            )
        };
        if copied == 0 {
            unsafe { SelectObject(memory_dc.as_ptr(), old_bitmap) };
            return Err("could not capture the virtual desktop".into());
        }
        unsafe { SelectObject(memory_dc.as_ptr(), old_bitmap) };

        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                biSizeImage: (width as u32)
                    .checked_mul(height as u32)
                    .and_then(|pixels| pixels.checked_mul(4))
                    .ok_or("desktop capture image is too large")?,
                ..BITMAPINFOHEADER::default()
            },
            ..BITMAPINFO::default()
        };
        let byte_count = info.bmiHeader.biSizeImage as usize;
        let mut bgra = vec![0_u8; byte_count];
        let rows = unsafe {
            GetDIBits(
                memory_dc.as_ptr(),
                bitmap.as_ptr() as HBITMAP,
                0,
                height as u32,
                bgra.as_mut_ptr().cast::<c_void>(),
                &mut info,
                DIB_RGB_COLORS,
            )
        };
        if rows != height {
            return Err("could not read the captured desktop pixels".into());
        }
        for pixel in bgra.as_chunks_mut::<4>().0 {
            pixel.swap(0, 2);
            pixel[3] = 255;
        }
        let mut png_data = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut png_data, width as u32, height as u32);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            encoder.set_compression(png::Compression::Fast);
            encoder.write_header()?.write_image_data(&bgra)?;
        }
        if png_data.len() > 8 * 1024 * 1024 {
            return Err("compressed screenshot exceeds the supported size limit".into());
        }
        Ok(serde_json::json!({
            "screenshot": {
                "mime_type": "image/png",
                "data": base64::engine::general_purpose::STANDARD.encode(png_data)
            }
        })
        .to_string())
    })();

    unsafe {
        DeleteObject(bitmap.as_ptr() as HGDIOBJ);
        DeleteDC(memory_dc.as_ptr() as HDC);
        ReleaseDC(null_mut(), screen_dc.as_ptr());
    }
    result
}

fn parse_args(args: impl Iterator<Item = OsString>) -> Result<LaunchOptions, String> {
    let mut workspace = None;
    let mut config = None;
    let mut args = args.peekable();
    while let Some(argument) = args.next() {
        if argument == OsStr::new("--workspace") {
            workspace = Some(PathBuf::from(
                args.next().ok_or("--workspace requires a path")?,
            ));
        } else if argument == OsStr::new("--config") {
            config = Some(PathBuf::from(
                args.next().ok_or("--config requires a path")?,
            ));
        } else if argument == OsStr::new("--help") || argument == OsStr::new("-h") {
            println!("Xyst AI Assistant Desktop\n\nUsage: xyst-desktop [--workspace <path>] [--config <path>]\n\nIf --workspace is omitted, the last workspace is reopened; on first launch, choose one from the native folder picker.");
            std::process::exit(0);
        } else {
            return Err(format!("unknown option: {}", argument.to_string_lossy()));
        }
    }
    Ok(LaunchOptions { workspace, config })
}

fn canonical_directory(path: &Path) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let path = path.canonicalize()?;
    if !path.is_dir() {
        return Err(format!("workspace is not a directory: {}", path.display()).into());
    }
    Ok(path)
}

fn absolute_path(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        env::current_dir().unwrap_or_default().join(path)
    }
}

fn resolve_node(app: &tauri::AppHandle) -> OsString {
    if let Some(override_path) = env::var_os("XYST_NODE") {
        return override_path;
    }
    let executable = if cfg!(windows) { "node.exe" } else { "node" };
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join("xyst/runtime").join(executable);
        if bundled.is_file() {
            return bundled.into_os_string();
        }
    }
    if cfg!(debug_assertions) {
        let staged = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../dist/desktop-runtime")
            .join(executable);
        if staged.is_file() {
            return staged.into_os_string();
        }
    }
    OsString::from(executable)
}

fn verify_node(node: &OsStr) -> Result<(), Box<dyn std::error::Error>> {
    let output = Command::new(node).arg("--version").output()
        .map_err(|_| "Could not start the bundled Node.js runtime; set XYST_NODE to an executable path to override it.")?;
    if !output.status.success() {
        return Err("Node.js could not be started. Check XYST_NODE and PATH.".into());
    }
    let version = String::from_utf8_lossy(&output.stdout);
    let major = version
        .trim()
        .strip_prefix('v')
        .and_then(|value| value.split('.').next())
        .and_then(|value| value.parse::<u32>().ok());
    if !major.is_some_and(|major| major >= 22) {
        return Err(format!("Node.js 22 or newer is required; found {}", version.trim()).into());
    }
    Ok(())
}

fn resolve_cli(app: &tauri::AppHandle) -> Result<PathBuf, Box<dyn std::error::Error>> {
    if cfg!(debug_assertions) {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../src/cli.mjs");
        if source.is_file() {
            return Ok(source.canonicalize()?);
        }
    }
    let bundled = app.path().resource_dir()?.join("xyst/src/cli.mjs");
    if bundled.is_file() {
        return Ok(bundled);
    }
    Err("Xyst AI Assistant runtime resources are missing from this installation".into())
}

fn start_service(
    node: &OsStr,
    cli: &Path,
    workspace: &Path,
    config: Option<&Path>,
) -> Result<(Child, ChildStdin, String), Box<dyn std::error::Error>> {
    let mut command = Command::new(node);
    command
        .arg(cli)
        .arg("--workspace")
        .arg(workspace)
        .arg("--desktop-parent")
        .arg("serve")
        .arg("--port")
        .arg("0")
        .current_dir(workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
        .env("XYST_NATIVE_HOST", env::current_exe()?)
        .env("XYST_APP_VERSION", env!("CARGO_PKG_VERSION"));
    configure_service_proxy(&mut command);
    if let Some(config) = config {
        command.arg("--config").arg(config);
    }
    let mut child = command
        .spawn()
        .map_err(|_| "Could not start the Xyst AI Assistant service using Node.js")?;
    let input = match child.stdin.take() {
        Some(input) => input,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Could not connect to the Xyst AI Assistant service control pipe".into());
        }
    };
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Could not read the Xyst AI Assistant service bootstrap pipe".into());
        }
    };
    if let Some(mut stderr) = child.stderr.take() {
        thread::spawn(move || {
            let _ = std::io::copy(&mut stderr, &mut std::io::sink());
        });
    }
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        let result = match reader.read_line(&mut line) {
            Ok(0) => Err("Xyst AI Assistant service exited before it was ready".to_string()),
            Ok(_) => Ok(line),
            Err(_) => {
                Err("Could not read the Xyst AI Assistant service bootstrap record".to_string())
            }
        };
        let _ = sender.send(result);
        let _ = std::io::copy(&mut reader, &mut std::io::sink());
    });
    let line = match receiver.recv_timeout(STARTUP_TIMEOUT) {
        Ok(Ok(line)) => line,
        Ok(Err(error)) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error.into());
        }
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Xyst AI Assistant service startup timed out".into());
        }
    };
    Ok((child, input, line))
}

fn configure_service_proxy(command: &mut Command) {
    let explicit_setting = env::var_os("NODE_USE_ENV_PROXY");
    if explicit_setting.is_some() && explicit_setting.as_deref() != Some(OsStr::new("1")) {
        return;
    }
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut proxy_configured = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]
        .iter()
        .any(|key| env::var_os(key).is_some_and(|value| !value.is_empty()));
    #[cfg(windows)]
    let system_proxy = system_proxy::current_user_manual_proxy();
    #[cfg(windows)]
    if let Some(settings) = &system_proxy {
        if env::var_os("HTTP_PROXY").is_none() && env::var_os("http_proxy").is_none() {
            if let Some(url) = &settings.http {
                command.env("HTTP_PROXY", url);
                proxy_configured = true;
            }
        }
        if env::var_os("HTTPS_PROXY").is_none() && env::var_os("https_proxy").is_none() {
            if let Some(url) = &settings.https {
                command.env("HTTPS_PROXY", url);
                proxy_configured = true;
            }
        }
    }
    if !proxy_configured && explicit_setting.as_deref() != Some(OsStr::new("1")) {
        return;
    }

    command.env("NODE_USE_ENV_PROXY", "1");
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut existing_bypass =
        combined_proxy_bypass(env::var_os("NO_PROXY"), env::var_os("no_proxy"));
    #[cfg(windows)]
    if let Some(system_bypass) = system_proxy.and_then(|settings| settings.bypass) {
        let bypass = existing_bypass.get_or_insert_with(OsString::new);
        if !bypass.is_empty() {
            bypass.push(",");
        }
        bypass.push(system_bypass);
    }
    let bypass = service_proxy_bypass(existing_bypass);
    command.env("NO_PROXY", &bypass);
    #[cfg(not(windows))]
    command.env("no_proxy", &bypass);
}

fn service_proxy_bypass(existing: Option<OsString>) -> OsString {
    let mut bypass = existing.unwrap_or_default();
    if !bypass.is_empty() {
        bypass.push(",");
    }
    bypass.push("localhost,127.0.0.1,::1,[::1]");
    bypass
}

fn combined_proxy_bypass(upper: Option<OsString>, lower: Option<OsString>) -> Option<OsString> {
    match (upper, lower) {
        (Some(mut upper), Some(lower)) if !lower.is_empty() && lower != upper => {
            if !upper.is_empty() {
                upper.push(",");
            }
            upper.push(lower);
            Some(upper)
        }
        (Some(upper), _) => Some(upper),
        (None, lower) => lower,
    }
}

fn validate_bootstrap(line: String) -> Result<Url, Box<dyn std::error::Error>> {
    let bootstrap: Bootstrap = serde_json::from_str(&line)
        .map_err(|_| "Xyst AI Assistant service returned an invalid bootstrap record")?;
    if bootstrap.api_version != 1 || bootstrap.token.len() < 32 {
        return Err(
            "Xyst AI Assistant service returned an unsupported or invalid bootstrap record".into(),
        );
    }
    let url = Url::parse(&bootstrap.url)
        .map_err(|_| "Xyst AI Assistant service returned an invalid local URL")?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || url.username() != ""
        || url.password().is_some()
    {
        return Err(
            "Xyst AI Assistant service did not bind to the expected loopback origin".into(),
        );
    }
    Ok(url
        .join("/app")
        .map_err(|_| "Could not open the Xyst AI Assistant local app")?)
}

#[cfg(test)]
mod tests {
    use super::{
        combined_proxy_bypass, restore_last_session, restore_last_workspace, save_last_workspace,
        service_proxy_bypass, test_app_directories_root, write_window_bounds, LastSession,
        OsString, WindowBounds, MAX_SESSION_STATE_BYTES, MAX_WORKSPACE_STATE_BYTES,
        MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH,
    };
    use std::path::PathBuf;

    fn temporary_directory(label: &str) -> PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock should be after the Unix epoch")
            .as_nanos();
        std::env::current_dir()
            .expect("test workspace should be available")
            .join(".test-tmp")
            .join(format!("xyst-{label}-{}-{unique}", std::process::id()))
    }

    #[test]
    fn proxy_bypass_preserves_user_rules_and_keeps_local_services_direct() {
        assert_eq!(
            combined_proxy_bypass(
                Some(OsString::from(".one.example")),
                Some(OsString::from(".two.example"))
            ),
            Some(OsString::from(".one.example,.two.example"))
        );
        assert_eq!(
            service_proxy_bypass(Some(OsString::from(".company.test,10.0.0.0/8"))),
            OsString::from(".company.test,10.0.0.0/8,localhost,127.0.0.1,::1,[::1]")
        );
        assert_eq!(
            service_proxy_bypass(None),
            OsString::from("localhost,127.0.0.1,::1,[::1]")
        );
    }

    #[test]
    fn test_app_directories_override_requires_an_absolute_path_and_is_opt_in() {
        assert_eq!(test_app_directories_root(None).unwrap(), None);
        assert_eq!(
            test_app_directories_root(Some(OsString::from("relative-test-root"))),
            Err("XYST_TEST_APP_DIRECTORIES_ROOT must be an absolute path")
        );
        let root = temporary_directory("isolated-app-directories");
        assert_eq!(
            test_app_directories_root(Some(root.clone().into())).unwrap(),
            Some(root)
        );
    }

    #[test]
    fn window_bounds_reject_unusable_dimensions() {
        assert!(!WindowBounds {
            x: 0,
            y: 0,
            width: 759,
            height: MIN_WINDOW_HEIGHT,
            maximized: false,
        }
        .valid_size());
        assert!(!WindowBounds {
            x: 0,
            y: 0,
            width: MIN_WINDOW_WIDTH,
            height: 539,
            maximized: false,
        }
        .valid_size());
        assert!(!WindowBounds {
            x: 0,
            y: 0,
            width: 8193,
            height: 900,
            maximized: false,
        }
        .valid_size());
    }

    #[test]
    fn window_bounds_accept_supported_dimensions() {
        assert!(WindowBounds {
            x: -1920,
            y: 0,
            width: 1440,
            height: 920,
            maximized: false,
        }
        .valid_size());
    }

    #[test]
    fn window_bounds_accept_the_responsive_desktop_minimum() {
        assert!(WindowBounds {
            x: 0,
            y: 0,
            width: MIN_WINDOW_WIDTH,
            height: MIN_WINDOW_HEIGHT,
            maximized: false,
        }
        .valid_size());
    }

    #[test]
    fn window_bounds_are_replaced_after_each_resize() {
        let root = temporary_directory("window-bounds");
        let state = root.join("settings").join("window-state.json");
        let first = WindowBounds {
            x: 12,
            y: 34,
            width: 1440,
            height: 920,
            maximized: false,
        };
        let resized = WindowBounds {
            x: 20,
            y: 28,
            width: MIN_WINDOW_WIDTH,
            height: MIN_WINDOW_HEIGHT,
            maximized: true,
        };

        write_window_bounds(&state, first).expect("write initial window bounds");
        write_window_bounds(&state, resized).expect("replace window bounds after resize");
        let stored: WindowBounds =
            serde_json::from_slice(&std::fs::read(&state).expect("read persisted window bounds"))
                .expect("parse persisted window bounds");
        assert_eq!(stored.x, resized.x);
        assert_eq!(stored.y, resized.y);
        assert_eq!(stored.width, resized.width);
        assert_eq!(stored.height, resized.height);
        assert!(stored.maximized);

        std::fs::remove_dir_all(root).expect("remove window bounds fixture");
    }

    #[test]
    fn window_bounds_without_maximized_field_remain_compatible() {
        let previous = br#"{"x":12,"y":34,"width":1440,"height":920}"#;
        let bounds: WindowBounds =
            serde_json::from_slice(previous).expect("parse prior window bounds format");
        assert!(!bounds.maximized);
    }

    #[test]
    fn last_workspace_is_restored_and_updated_between_launches() {
        let root = temporary_directory("workspace-history");
        let first = root.join("Mechanic");
        let second = root.join("Another Project");
        let state = root.join("settings").join("last-workspace.json");
        std::fs::create_dir_all(&first).expect("create first workspace");
        std::fs::create_dir_all(&second).expect("create second workspace");

        save_last_workspace(&state, &first);
        assert_eq!(restore_last_workspace(&state), first.canonicalize().ok());
        save_last_workspace(&state, &second);
        assert_eq!(restore_last_workspace(&state), second.canonicalize().ok());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let permissions = std::fs::metadata(&state)
                .expect("read saved workspace permissions")
                .permissions()
                .mode();
            assert_eq!(permissions & 0o777, 0o600);
        }

        std::fs::remove_dir_all(root).expect("remove workspace history fixture");
    }

    #[test]
    fn last_session_state_is_uuid_validated_and_bounded() {
        let root = temporary_directory("session-history");
        let state = root.join("last-session.json");
        std::fs::create_dir_all(&root).expect("create session history fixture");
        let id = "550e8400-e29b-41d4-a716-446655440000";
        std::fs::write(
            &state,
            serde_json::to_vec(&LastSession { id: id.to_owned() })
                .expect("encode selected session"),
        )
        .expect("write selected session state");
        assert_eq!(restore_last_session(&state).as_deref(), Some(id));
        std::fs::write(&state, br#"{"id":"not-a-uuid"}"#).expect("write invalid session state");
        assert_eq!(restore_last_session(&state), None);
        std::fs::write(&state, vec![b'x'; MAX_SESSION_STATE_BYTES as usize + 1])
            .expect("write oversized session state");
        assert_eq!(restore_last_session(&state), None);
        std::fs::remove_dir_all(root).expect("remove session history fixture");
    }

    #[test]
    fn last_workspace_ignores_invalid_or_missing_directories() {
        let root = temporary_directory("workspace-history-invalid");
        let state = root.join("last-workspace.json");
        std::fs::create_dir_all(&root).expect("create workspace history fixture");
        std::fs::write(&state, br#"{"path":"missing-project"}"#).expect("write stale workspace");
        assert_eq!(restore_last_workspace(&state), None);
        std::fs::write(&state, b"not json").expect("write malformed workspace state");
        assert_eq!(restore_last_workspace(&state), None);
        std::fs::remove_dir_all(root).expect("remove workspace history fixture");
    }

    #[test]
    fn last_workspace_rejects_hard_linked_state_files() {
        let root = temporary_directory("workspace-history-hard-link");
        let workspace = root.join("Mechanic");
        let state = root.join("last-workspace.json");
        let alias = root.join("other-state.json");
        std::fs::create_dir_all(&workspace).expect("create workspace fixture");
        save_last_workspace(&state, &workspace);
        std::fs::hard_link(&state, &alias).expect("create hard-linked state file");

        assert_eq!(restore_last_workspace(&state), None);
        assert_eq!(restore_last_workspace(&alias), None);

        std::fs::remove_dir_all(root).expect("remove workspace history fixture");
    }

    #[cfg(unix)]
    #[test]
    fn last_workspace_rejects_symbolic_linked_state_files() {
        use std::os::unix::fs::symlink;

        let root = temporary_directory("workspace-history-symlink");
        let workspace = root.join("Mechanic");
        let state = root.join("last-workspace.json");
        let link = root.join("linked-workspace.json");
        std::fs::create_dir_all(&workspace).expect("create workspace fixture");
        save_last_workspace(&state, &workspace);
        symlink(&state, &link).expect("create linked workspace-state fixture");

        assert_eq!(restore_last_workspace(&link), None);

        std::fs::remove_dir_all(root).expect("remove workspace history fixture");
    }

    #[test]
    fn last_workspace_rejects_state_files_over_the_read_limit() {
        let root = temporary_directory("workspace-history-oversized");
        let state = root.join("last-workspace.json");
        std::fs::create_dir_all(&root).expect("create workspace history fixture");
        std::fs::write(&state, vec![b'x'; MAX_WORKSPACE_STATE_BYTES as usize + 1])
            .expect("write oversized workspace state");

        assert_eq!(restore_last_workspace(&state), None);

        std::fs::remove_dir_all(root).expect("remove workspace history fixture");
    }
}
