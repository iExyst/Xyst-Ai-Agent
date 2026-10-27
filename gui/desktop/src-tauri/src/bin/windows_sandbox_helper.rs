#[cfg(windows)]
#[path = "../windows_sandbox.rs"]
mod windows_sandbox;

#[cfg(windows)]
mod windows {
    use super::windows_sandbox::AppContainerCommand;
    use base64::engine::general_purpose::STANDARD as BASE64;
    use base64::Engine;
    use serde::{Deserialize, Serialize};
    use std::collections::BTreeMap;
    use std::io::{self, Write};
    use std::path::PathBuf;
    use std::ptr::{null, null_mut};
    use std::thread;
    use std::time::Duration;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Storage::FileSystem::ReadFile;
    use windows_sys::Win32::System::Console::{GetStdHandle, STD_INPUT_HANDLE};
    use windows_sys::Win32::System::Threading::{CreateEventW, SetEvent};

    const MAX_REQUEST_BYTES: u64 = 2 * 1024 * 1024;

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Request {
        version: u32,
        executable: PathBuf,
        args: Vec<String>,
        workspace_root: PathBuf,
        #[serde(default)]
        workspace_read_only: bool,
        current_directory: PathBuf,
        environment: BTreeMap<String, String>,
        timeout_ms: u64,
        #[serde(default)]
        stdin_base64: String,
    }

    #[derive(Serialize)]
    struct Response {
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<CommandResult>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    }

    #[derive(Serialize)]
    struct CommandResult {
        exit_code: u32,
        timed_out: bool,
        cancelled: bool,
        elapsed_ms: u128,
        stdout_base64: String,
        stderr_base64: String,
        stdout_truncated: bool,
        stderr_truncated: bool,
    }

    pub fn run() -> i32 {
        let input = unsafe { GetStdHandle(STD_INPUT_HANDLE) };
        if input.is_null() || input == INVALID_HANDLE_VALUE {
            return write_response(error_response("Sandbox helper stdin handle is unavailable"));
        }
        let response = read_request(input).and_then(|request| {
            let cancellation = unsafe { CreateEventW(null(), 1, 0, null()) };
            if cancellation.is_null() {
                return Err("Could not create AppContainer cancellation event".into());
            }
            let cancellation = HelperHandle(cancellation);
            start_control_reader(input, cancellation.0)?;
            execute(request, cancellation.0)
        });
        match response {
            Ok(result) => write_response(Response {
                ok: true,
                result: Some(result),
                error: None,
            }),
            Err(error) => write_response(error_response(error)),
        }
    }

    fn error_response(error: impl Into<String>) -> Response {
        Response {
            ok: false,
            result: None,
            error: Some(error.into()),
        }
    }

    fn write_response(response: Response) -> i32 {
        let is_ok = response.ok;
        let mut output = io::BufWriter::new(io::stdout().lock());
        if serde_json::to_writer(&mut output, &response).is_err()
            || writeln!(output).is_err()
            || output.flush().is_err()
        {
            return 3;
        }
        if is_ok {
            0
        } else {
            1
        }
    }

    fn read_request(input: HANDLE) -> Result<Request, String> {
        let mut bytes = Vec::new();
        loop {
            let mut byte = 0u8;
            let mut read = 0u32;
            if unsafe { ReadFile(input, &mut byte, 1, &mut read, null_mut()) } == 0 {
                return Err("Could not read sandbox request".into());
            }
            if read == 0 {
                return Err("Sandbox request ended before its newline".into());
            }
            if byte == b'\n' {
                break;
            }
            bytes.push(byte);
            if bytes.len() as u64 > MAX_REQUEST_BYTES {
                return Err("Sandbox request exceeds the size limit".into());
            }
        }
        let request: Request = serde_json::from_slice(&bytes)
            .map_err(|error| format!("Invalid sandbox request: {error}"))?;
        if request.version != 1 {
            return Err("Unsupported sandbox protocol version".into());
        }
        if request.args.len() > 256 {
            return Err("Sandbox request has too many arguments".into());
        }
        if request.stdin_base64.len() > 88_000 {
            return Err("Sandbox stdin exceeds the encoded size limit".into());
        }
        Ok(request)
    }

    fn start_control_reader(input: HANDLE, cancellation: HANDLE) -> Result<(), String> {
        // Windows handles are process-wide kernel references; transport their bit pattern
        // across the thread boundary and reconstruct the typed handles inside the reader.
        let input = input as usize;
        let cancellation = cancellation as usize;
        thread::Builder::new()
            .name("xyst-sandbox-control".into())
            .spawn(move || {
                let input = input as HANDLE;
                let cancellation = cancellation as HANDLE;
                let mut line = Vec::with_capacity(16);
                loop {
                    let mut byte = 0u8;
                    let mut read = 0u32;
                    if unsafe { ReadFile(input, &mut byte, 1, &mut read, null_mut()) } == 0
                        || read == 0
                    {
                        return;
                    }
                    if byte == b'\n' {
                        if line == b"CANCEL" {
                            unsafe { SetEvent(cancellation) };
                            return;
                        }
                        line.clear();
                    } else if line.len() < 16 {
                        line.push(byte);
                    } else {
                        line.clear();
                    }
                }
            })
            .map(|_| ())
            .map_err(|error| format!("Could not start sandbox control reader: {error}"))
    }

    fn execute(request: Request, cancellation: HANDLE) -> Result<CommandResult, String> {
        let stdin = BASE64
            .decode(request.stdin_base64)
            .map_err(|error| format!("Invalid sandbox stdin encoding: {error}"))?;
        if stdin.len() > 65_536 {
            return Err("Sandbox stdin exceeds the 65536-byte limit".into());
        }
        let timeout = Duration::from_millis(request.timeout_ms);
        let outcome = if stdin.is_empty() {
            super::windows_sandbox::run_appcontainer_command_with_mode(AppContainerCommand {
                executable: &request.executable,
                args: &request.args,
                workspace_root: &request.workspace_root,
                workspace_read_only: request.workspace_read_only,
                current_directory: &request.current_directory,
                environment: &request.environment,
                stdin: &[],
                timeout,
                cancellation_event: Some(cancellation),
            })?
        } else {
            super::windows_sandbox::run_appcontainer_command_with_input(AppContainerCommand {
                executable: &request.executable,
                args: &request.args,
                workspace_root: &request.workspace_root,
                workspace_read_only: request.workspace_read_only,
                current_directory: &request.current_directory,
                environment: &request.environment,
                stdin: &stdin,
                timeout,
                cancellation_event: Some(cancellation),
            })?
        };
        Ok(CommandResult {
            exit_code: outcome.exit_code,
            timed_out: outcome.timed_out,
            cancelled: outcome.cancelled,
            elapsed_ms: outcome.elapsed.as_millis(),
            stdout_base64: BASE64.encode(outcome.stdout),
            stderr_base64: BASE64.encode(outcome.stderr),
            stdout_truncated: outcome.stdout_truncated,
            stderr_truncated: outcome.stderr_truncated,
        })
    }

    const INVALID_HANDLE_VALUE: HANDLE = -1isize as HANDLE;

    struct HelperHandle(HANDLE);

    impl Drop for HelperHandle {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }
}

#[cfg(windows)]
fn main() {
    std::process::exit(windows::run());
}

#[cfg(not(windows))]
fn main() {
    eprintln!("xyst-sandbox-helper is supported only on Windows");
    std::process::exit(2);
}
