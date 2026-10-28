#![cfg(windows)]

use std::ffi::OsStr;
use std::io::{self, Write};
use std::os::windows::ffi::OsStrExt;
use std::ptr::{null, null_mut};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE};
use windows_sys::Win32::Storage::FileSystem::{ReadFile, WriteFile};
use windows_sys::Win32::System::Console::{
    COORD, ClosePseudoConsole, CreatePseudoConsole, GetStdHandle, ResizePseudoConsole,
    STD_INPUT_HANDLE,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT,
    GetExitCodeProcess, INFINITE, InitializeProcThreadAttributeList,
    PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, PROCESS_INFORMATION, STARTF_USESTDHANDLES, STARTUPINFOEXW,
    TerminateProcess, UpdateProcThreadAttribute, WaitForSingleObject,
};

const WAIT_OBJECT_0: u32 = 0;

fn fail<T>(message: &str) -> io::Result<T> {
    Err(io::Error::other(format!(
        "{message} (Windows error {})",
        unsafe { GetLastError() }
    )))
}

fn quote_arg(value: &OsStr) -> String {
    let value = value.to_string_lossy();
    let mut result = String::from("\"");
    let mut slashes = 0;
    for character in value.chars() {
        match character {
            '\\' => slashes += 1,
            '"' => {
                result.push_str(&"\\".repeat(slashes * 2 + 1));
                result.push('"');
                slashes = 0;
            }
            _ => {
                result.push_str(&"\\".repeat(slashes));
                result.push(character);
                slashes = 0;
            }
        }
    }
    result.push_str(&"\\".repeat(slashes * 2));
    result.push('"');
    result
}

unsafe fn create_pipe() -> io::Result<(HANDLE, HANDLE)> {
    let mut read = null_mut();
    let mut write = null_mut();
    if unsafe { CreatePipe(&mut read, &mut write, null(), 0) } == 0 {
        return fail("CreatePipe failed");
    }
    Ok((read, write))
}

unsafe fn write_all(handle: HANDLE, mut bytes: &[u8]) -> io::Result<()> {
    while !bytes.is_empty() {
        let mut written = 0;
        if unsafe {
            WriteFile(
                handle,
                bytes.as_ptr(),
                bytes.len().min(u32::MAX as usize) as u32,
                &mut written,
                null_mut(),
            )
        } == 0
        {
            return fail("WriteFile to ConPTY failed");
        }
        if written == 0 {
            return Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "ConPTY accepted no input",
            ));
        }
        bytes = &bytes[written as usize..];
    }
    Ok(())
}

fn decode_hex(value: &str) -> io::Result<Vec<u8>> {
    if !value.len().is_multiple_of(2) || value.len() > 131_072 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "input hex must be even and at most 64 KiB",
        ));
    }
    (0..value.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&value[index..index + 2], 16)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))
        })
        .collect()
}

fn run() -> io::Result<u32> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "usage: xyst-windows-conpty-test <program> [args...]",
        ));
    }
    let command_line = args
        .iter()
        .map(|arg| quote_arg(arg))
        .collect::<Vec<_>>()
        .join(" ");
    let mut command_wide: Vec<u16> = OsStr::new(&command_line)
        .encode_wide()
        .chain(Some(0))
        .collect();

    unsafe {
        let (input_read, input_write) = create_pipe()?;
        let (output_read, output_write) = match create_pipe() {
            Ok(value) => value,
            Err(error) => {
                CloseHandle(input_read);
                CloseHandle(input_write);
                return Err(error);
            }
        };

        let mut pseudoconsole = 0;
        let result = CreatePseudoConsole(
            COORD { X: 100, Y: 30 },
            input_read,
            output_write,
            0,
            &mut pseudoconsole,
        );
        CloseHandle(input_read);
        CloseHandle(output_write);
        if result < 0 {
            CloseHandle(input_write);
            CloseHandle(output_read);
            return Err(io::Error::from_raw_os_error(result));
        }
        debug("pseudo console created");

        let mut attribute_bytes = 0usize;
        InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut attribute_bytes);
        if attribute_bytes == 0 {
            ClosePseudoConsole(pseudoconsole);
            CloseHandle(input_write);
            CloseHandle(output_read);
            return fail("Could not size the process attribute list");
        }
        let mut attributes = vec![0u8; attribute_bytes];
        let attribute_list = attributes.as_mut_ptr().cast();
        if InitializeProcThreadAttributeList(attribute_list, 1, 0, &mut attribute_bytes) == 0 {
            ClosePseudoConsole(pseudoconsole);
            CloseHandle(input_write);
            CloseHandle(output_read);
            return fail("InitializeProcThreadAttributeList failed");
        }

        let mut startup = STARTUPINFOEXW::default();
        startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags |= STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = null_mut();
        startup.StartupInfo.hStdOutput = null_mut();
        startup.StartupInfo.hStdError = null_mut();
        startup.lpAttributeList = attribute_list;
        if UpdateProcThreadAttribute(
            attribute_list,
            0,
            PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
            pseudoconsole as *const _,
            std::mem::size_of_val(&pseudoconsole),
            null_mut(),
            null(),
        ) == 0
        {
            DeleteProcThreadAttributeList(attribute_list);
            ClosePseudoConsole(pseudoconsole);
            CloseHandle(input_write);
            CloseHandle(output_read);
            return fail("Could not attach the pseudo console");
        }

        // Start draining ConPTY output before the child initializes its console.
        // Console startup can block while output is pending, so the reader must
        // already be active when CreateProcessW attaches the pseudoconsole.
        let output_handle = output_read as usize;
        let output_thread = thread::spawn(move || -> io::Result<()> {
            let output_read = output_handle as HANDLE;
            let stdout = io::stdout();
            let mut stdout = stdout.lock();
            let mut buffer = [0u8; 8192];
            loop {
                let mut read = 0;
                if ReadFile(
                    output_read,
                    buffer.as_mut_ptr(),
                    buffer.len() as u32,
                    &mut read,
                    null_mut(),
                ) == 0
                    || read == 0
                {
                    break;
                }
                stdout.write_all(&buffer[..read as usize])?;
                stdout.flush()?;
            }
            CloseHandle(output_read);
            Ok(())
        });

        let mut process = PROCESS_INFORMATION::default();
        let created = CreateProcessW(
            null(),
            command_wide.as_mut_ptr(),
            null(),
            null(),
            0,
            EXTENDED_STARTUPINFO_PRESENT,
            null(),
            null(),
            &startup.StartupInfo,
            &mut process,
        );
        DeleteProcThreadAttributeList(attribute_list);
        if created == 0 {
            ClosePseudoConsole(pseudoconsole);
            CloseHandle(input_write);
            output_thread
                .join()
                .map_err(|_| io::Error::other("ConPTY output reader panicked"))??;
            return fail("CreateProcessW failed");
        }
        debug("child process created");

        let (control_tx, control_rx) = mpsc::channel();
        let control_input = GetStdHandle(STD_INPUT_HANDLE) as usize;
        thread::spawn(move || {
            let mut buffer = [0u8; 4096];
            let mut pending = Vec::new();
            loop {
                let mut read = 0;
                if ReadFile(
                    control_input as HANDLE,
                    buffer.as_mut_ptr(),
                    buffer.len() as u32,
                    &mut read,
                    null_mut(),
                ) == 0
                    || read == 0
                {
                    break;
                }
                pending.extend_from_slice(&buffer[..read as usize]);
                if pending.len() > 131_075 {
                    let _ = control_tx.send(Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "control line exceeded 64 KiB",
                    )));
                    break;
                }
                while let Some(end) = pending.iter().position(|byte| *byte == b'\n') {
                    let line: Vec<_> = pending.drain(..=end).collect();
                    let line = String::from_utf8(line)
                        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error));
                    if control_tx.send(line).is_err() {
                        break;
                    }
                }
            }
        });
        let mut child_exit_code = None;
        loop {
            match control_rx.recv_timeout(Duration::from_millis(50)) {
                Ok(Ok(line)) => {
                    let command = line.trim_end_matches(['\r', '\n']);
                    debug(&format!("control received: {command}"));
                    if command == "Q" {
                        break;
                    } else if let Some(hex) = command.strip_prefix("I ") {
                        write_all(input_write, &decode_hex(hex)?)?;
                    } else if let Some(size) = command.strip_prefix("R ") {
                        let mut fields = size.split_ascii_whitespace();
                        let columns = fields.next().and_then(|v| v.parse::<i16>().ok());
                        let rows = fields.next().and_then(|v| v.parse::<i16>().ok());
                        if let (Some(columns), Some(rows)) = (columns, rows)
                            && (1..=500).contains(&columns)
                            && (1..=300).contains(&rows)
                            && fields.next().is_none()
                        {
                            let resized = ResizePseudoConsole(
                                pseudoconsole,
                                COORD {
                                    X: columns,
                                    Y: rows,
                                },
                            );
                            if resized < 0 {
                                return Err(io::Error::from_raw_os_error(resized));
                            }
                        } else {
                            return Err(io::Error::new(
                                io::ErrorKind::InvalidInput,
                                "resize must be R <columns 1-500> <rows 1-300>",
                            ));
                        }
                    } else {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidInput,
                            "control must be I <hex>, R <columns> <rows>, or Q",
                        ));
                    }
                }
                Ok(Err(error)) => return Err(error),
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            let mut exit_code = 0;
            if WaitForSingleObject(process.hProcess, 0) == WAIT_OBJECT_0 {
                debug("child process exited");
                GetExitCodeProcess(process.hProcess, &mut exit_code);
                child_exit_code = Some(exit_code);
                break;
            }
        }

        CloseHandle(input_write);
        if child_exit_code.is_none() {
            let wait_result = WaitForSingleObject(process.hProcess, 10_000);
            debug(&format!("child wait result: {wait_result}"));
            if wait_result != WAIT_OBJECT_0 {
                TerminateProcess(process.hProcess, 1);
                WaitForSingleObject(process.hProcess, INFINITE);
            }
        }
        let mut exit_code = child_exit_code.unwrap_or(1);
        if child_exit_code.is_none() {
            GetExitCodeProcess(process.hProcess, &mut exit_code);
        }
        if exit_code == 0xC000_0142 {
            let _ = writeln!(
                io::stderr(),
                "ConPTY child exited with NTSTATUS 0xC0000142 (DLL initialization failed)"
            );
        }
        debug(&format!("child exit code: {exit_code}"));
        ClosePseudoConsole(pseudoconsole);
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
        output_thread
            .join()
            .map_err(|_| io::Error::other("ConPTY output reader panicked"))??;
        Ok(exit_code)
    }
}

fn debug(message: &str) {
    if std::env::var_os("XYST_CONPTY_DEBUG").is_some() {
        let _ = writeln!(io::stderr(), "ConPTY debug: {message}");
    }
}

fn main() {
    match run() {
        Ok(exit_code) => std::process::exit(exit_code.min(255) as i32),
        Err(error) => {
            let _ = writeln!(io::stderr(), "ConPTY test harness: {error}");
            std::process::exit(1);
        }
    }
}
