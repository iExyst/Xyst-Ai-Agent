//! Native Windows process-isolation primitives.
//!
//! This AppContainer prototype provides scoped workspace access, no-capability
//! network isolation, bounded stdio capture, and kill-on-close process-tree
//! control. Required-sandbox use is fail-closed; this prototype still needs
//! full escape testing and independent security review before being treated as
//! a production security boundary.

use std::collections::BTreeMap;
use std::ffi::{c_void, OsString};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::mem::size_of;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::os::windows::io::{FromRawHandle, RawHandle};
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{
    CloseHandle, GetHandleInformation, GetLastError, LocalFree, SetHandleInformation, HANDLE,
    HANDLE_FLAG_INHERIT, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::Authorization::{
    BuildTrusteeWithSidW, ConvertSidToStringSidW, ConvertStringSidToSidW, GetSecurityInfo,
    SetEntriesInAclW, SetSecurityInfo, DENY_ACCESS, EXPLICIT_ACCESS_W, GRANT_ACCESS, REVOKE_ACCESS,
    SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::Isolation::{
    CreateAppContainerProfile, DeleteAppContainerProfile,
    DeriveAppContainerSidFromAppContainerName, GetAppContainerFolderPath,
};
#[cfg(test)]
use windows_sys::Win32::Security::PROTECTED_DACL_SECURITY_INFORMATION;
use windows_sys::Win32::Security::{
    EqualSid, FreeSid, GetSecurityDescriptorControl, DACL_SECURITY_INFORMATION, INHERIT_ONLY_ACE,
    OBJECT_INHERIT_ACE, SECURITY_ATTRIBUTES, SECURITY_CAPABILITIES, SE_DACL_PROTECTED,
    UNPROTECTED_DACL_SECURITY_INFORMATION,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, GetFileInformationByHandle, MoveFileExW, BY_HANDLE_FILE_INFORMATION,
    FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_EXECUTE, FILE_GENERIC_READ, FILE_GENERIC_WRITE,
    FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    FILE_WRITE_ATTRIBUTES, MOVEFILE_WRITE_THROUGH, OPEN_EXISTING, READ_CONTROL, WRITE_DAC,
};
use windows_sys::Win32::System::Com::CoTaskMemFree;
use windows_sys::Win32::System::Console::{
    GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
    InitializeProcThreadAttributeList, ResumeThread, TerminateProcess, UpdateProcThreadAttribute,
    WaitForMultipleObjects, WaitForSingleObject, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT,
    EXTENDED_STARTUPINFO_PRESENT, PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
    STARTF_USESTDHANDLES, STARTUPINFOEXW,
};

const MAX_COMMAND_LINE_UNITS: usize = 32_767;
const MAX_ENVIRONMENT_UNITS: usize = 32 * 1024 * 1024 / size_of::<u16>();
const PROFILE_PREFIX: &str = "XystAISandbox_";
const MAX_RECOVERY_RECORD_BYTES: u64 = 16 * 1024;
const MAX_AGENT_STATE_DACL_BYTES: usize = 2 * 1024;
const MAX_CAPTURED_STREAM_BYTES: usize = 1024 * 1024;
const FILE_DELETE_CHILD: u32 = 0x0000_0040;
const WORKSPACE_ACCESS: u32 = FILE_GENERIC_READ
    | FILE_GENERIC_WRITE
    | FILE_GENERIC_EXECUTE
    | FILE_WRITE_ATTRIBUTES
    | 0x0001_0000; // DELETE
const WORKSPACE_READ_ONLY_ACCESS: u32 = FILE_GENERIC_READ | FILE_GENERIC_EXECUTE;

/// Launch an absolute executable with explicit arguments and environment in a
/// no-capability AppContainer. The process is assigned to a kill-on-close job
/// before its primary thread resumes. Timeout and cancellation terminate the
/// entire job. Standard output and error are drained concurrently and capped
/// independently at one MiB; stdin is closed immediately so commands observe EOF.
#[cfg(not(feature = "sandbox-helper"))]
pub fn run_appcontainer_command(
    executable: &Path,
    args: &[String],
    workspace_root: &Path,
    current_directory: &Path,
    environment: &BTreeMap<String, String>,
    timeout: Duration,
    cancellation_event: Option<HANDLE>,
) -> Result<CommandOutcome, String> {
    run_appcontainer_command_with_mode(AppContainerCommand {
        executable,
        args,
        workspace_root,
        workspace_read_only: false,
        current_directory,
        environment,
        stdin: &[],
        timeout,
        cancellation_event,
    })
}

pub fn run_appcontainer_command_with_mode(
    mut command: AppContainerCommand<'_>,
) -> Result<CommandOutcome, String> {
    command.stdin = &[];
    run_appcontainer_command_with_input(command)
}

pub struct AppContainerCommand<'a> {
    pub executable: &'a Path,
    pub args: &'a [String],
    pub workspace_root: &'a Path,
    pub workspace_read_only: bool,
    pub current_directory: &'a Path,
    pub environment: &'a BTreeMap<String, String>,
    pub stdin: &'a [u8],
    pub timeout: Duration,
    pub cancellation_event: Option<HANDLE>,
}

pub fn run_appcontainer_command_with_input(
    command: AppContainerCommand<'_>,
) -> Result<CommandOutcome, String> {
    let AppContainerCommand {
        executable,
        args,
        workspace_root,
        workspace_read_only,
        current_directory,
        environment,
        stdin,
        timeout,
        cancellation_event,
    } = command;
    if !executable.is_absolute()
        || !workspace_root.is_absolute()
        || !current_directory.is_absolute()
    {
        return Err(
            "AppContainer executable, workspace, and working directory must be absolute paths"
                .into(),
        );
    }
    if args.len() > 256 || args.iter().any(|arg| arg.contains('\0')) {
        return Err("AppContainer arguments are invalid".into());
    }
    if stdin.len() > 65_536 {
        return Err("AppContainer stdin exceeds the 65536-byte limit".into());
    }
    if timeout.as_millis() == 0 || timeout.as_millis() > u32::MAX as u128 - 1 {
        return Err("AppContainer timeout must be between 1 ms and 49 days".into());
    }
    if cancellation_event.is_some_and(|event| event.is_null() || event == INVALID_HANDLE_VALUE) {
        return Err("AppContainer cancellation event is invalid".into());
    }
    let workspace_root = canonical_workspace(workspace_root)?;
    let current_directory = std::fs::canonicalize(current_directory)
        .map_err(|error| format!("Could not resolve AppContainer working directory: {error}"))?;
    let current_directory = strip_extended_prefix(&current_directory);
    if contains_agent_state_segment(&workspace_root)
        || contains_agent_state_segment(&current_directory)
    {
        return Err("Xyst state directories cannot be used as an AppContainer workspace or working directory".into());
    }
    if !is_within_workspace(&workspace_root, &current_directory) {
        return Err("AppContainer working directory must be inside the selected workspace".into());
    }

    if environment.is_empty() {
        return Err("AppContainer launch requires an explicit environment block".into());
    }
    let local_app_data = environment_value(environment, "LOCALAPPDATA").ok_or_else(|| {
        "AppContainer launch requires LOCALAPPDATA in its explicit environment".to_owned()
    })?;
    if !Path::new(local_app_data).is_absolute() {
        return Err("LOCALAPPDATA must be an absolute path".into());
    }
    let recovery = SandboxRecovery::open(Path::new(local_app_data))?;
    recovery.recover()?;
    let mut random = [0u8; 16];
    getrandom::fill(&mut random)
        .map_err(|error| format!("Could not create sandbox identity: {error}"))?;
    let identity = format!("{PROFILE_PREFIX}{}", hex(&random));
    let mut profile = AppContainerProfile::create(&identity)?;
    let workspace_identity = capture_workspace_identity(&workspace_root)?;
    let agent_state_path = ensure_real_child_directory(&workspace_root, ".agent")?;
    validate_workspace_tree(&workspace_root)?;
    let agent_state_dacl = capture_agent_state_dacl(&agent_state_path)?;
    let sid = sid_to_string(profile.sid)?;
    let journal = recovery.write(RecoveryRecord {
        version: 3,
        profile_identity: identity.clone(),
        sid,
        workspace_path: workspace_root.to_string_lossy().into_owned(),
        workspace_identity,
        agent_state_dacl: Some(agent_state_dacl.clone()),
        agent_state_identity: Some(capture_workspace_identity(&agent_state_path)?),
    })?;
    let workspace_grant = WorkspaceAclGrant::apply(
        &workspace_root,
        profile.sid,
        workspace_identity,
        workspace_read_only,
        agent_state_dacl,
    )?;
    let command_line = build_command_line(executable, args)?;
    let mut command_line: Vec<u16> = command_line
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let app_container_local_data = profile.local_data_path()?;
    let app_container_temp = app_container_local_data.join("Temp");
    std::fs::create_dir_all(&app_container_temp).map_err(|error| {
        format!("Could not create private AppContainer temp directory: {error}")
    })?;
    let app_container_temp = PrivateTempDirectory(app_container_temp);
    let mut app_container_environment = environment.clone();
    app_container_environment.retain(|key, _| {
        !["TEMP", "TMP"]
            .iter()
            .any(|name| key.eq_ignore_ascii_case(name))
    });
    app_container_environment.insert(
        "TEMP".to_owned(),
        app_container_temp.0.to_string_lossy().into_owned(),
    );
    app_container_environment.insert(
        "TMP".to_owned(),
        app_container_temp.0.to_string_lossy().into_owned(),
    );
    let mut environment_block = build_environment_block(&app_container_environment)?;
    let current_directory: Vec<u16> = current_directory
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let job = unsafe { CreateJobObjectW(null(), null()) };
    if job.is_null() {
        return Err(win32_error("Could not create the sandbox process job"));
    }
    let job_handle = OwnedHandle(job);
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if unsafe {
        SetInformationJobObject(
            job_handle.0,
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    } == 0
    {
        return Err(win32_error("Could not set sandbox job limits"));
    }

    let (stdin_read, stdin_write) = create_inheritable_pipe()?;
    let (stdout_read, stdout_write) = create_inheritable_pipe()?;
    let (stderr_read, stderr_write) = create_inheritable_pipe()?;
    make_noninheritable(&stdin_write)?;
    make_noninheritable(&stdout_read)?;
    make_noninheritable(&stderr_read)?;

    let mut attribute_bytes = 0usize;
    unsafe {
        let _ = InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut attribute_bytes);
    }
    if attribute_bytes == 0 {
        return Err(win32_error(
            "Could not size AppContainer process attributes",
        ));
    }
    let mut attribute_storage = vec![0usize; attribute_bytes.div_ceil(size_of::<usize>())];
    let attribute_list = attribute_storage.as_mut_ptr().cast::<c_void>();
    if unsafe { InitializeProcThreadAttributeList(attribute_list, 1, 0, &mut attribute_bytes) } == 0
    {
        return Err(win32_error(
            "Could not initialize AppContainer process attributes",
        ));
    }
    let attributes = AttributeList(attribute_list);
    let mut capabilities = SECURITY_CAPABILITIES {
        AppContainerSid: profile.sid,
        Capabilities: null_mut(),
        CapabilityCount: 0,
        Reserved: 0,
    };
    if unsafe {
        UpdateProcThreadAttribute(
            attributes.0,
            0,
            PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
            (&mut capabilities as *mut SECURITY_CAPABILITIES).cast(),
            size_of::<SECURITY_CAPABILITIES>(),
            null_mut(),
            null(),
        )
    } == 0
    {
        return Err(win32_error(
            "Could not attach AppContainer security capabilities",
        ));
    }
    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = stdin_read.0;
    startup.StartupInfo.hStdOutput = stdout_write.0;
    startup.StartupInfo.hStdError = stderr_write.0;
    startup.lpAttributeList = attributes.0;
    let mut process = PROCESS_INFORMATION::default();
    // Windows rejects HANDLE_LIST when combined with the AppContainer security
    // capabilities attribute. The single-use helper receives only standard handles
    // from Node; temporarily suppress those protocol handles so the sandbox child
    // inherits only the three dedicated stdio pipe ends created above.
    let _standard_handles =
        StandardHandleInheritanceGuard::exclude(&[stdin_read.0, stdout_write.0, stderr_write.0])?;
    let created = unsafe {
        CreateProcessW(
            executable
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect::<Vec<_>>()
                .as_ptr(),
            command_line.as_mut_ptr(),
            null(),
            null(),
            1,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
            environment_block.as_mut_ptr().cast(),
            current_directory.as_ptr(),
            (&mut startup as *mut STARTUPINFOEXW).cast(),
            &mut process,
        )
    };
    if created == 0 {
        return Err(win32_error("Could not create the AppContainer process"));
    }
    let process_handles = ProcessHandles(process);
    if unsafe { AssignProcessToJobObject(job_handle.0, process_handles.0.hProcess) } == 0 {
        unsafe { TerminateProcess(process_handles.0.hProcess, 1) };
        return Err(win32_error(
            "Could not assign the suspended process to its sandbox job",
        ));
    }
    drop(stdin_read);
    drop(stdout_write);
    drop(stderr_write);
    let stdin_writer = spawn_stdin_writer(stdin_write, stdin.to_vec())?;
    let stdout_reader = spawn_capture_reader(stdout_read)?;
    let stderr_reader = spawn_capture_reader(stderr_read)?;
    let started = Instant::now();
    let cancelled_before_resume = match cancellation_event {
        Some(event) => match unsafe { WaitForSingleObject(event, 0) } {
            WAIT_OBJECT_0 => true,
            WAIT_TIMEOUT => false,
            _ => {
                unsafe { TerminateJobObject(job_handle.0, 1) };
                return Err(win32_error(
                    "Could not inspect AppContainer cancellation event",
                ));
            }
        },
        None => false,
    };
    if cancelled_before_resume {
        if unsafe { TerminateJobObject(job_handle.0, 1) } == 0 {
            return Err(win32_error("Could not cancel the AppContainer process job"));
        }
    } else if unsafe { ResumeThread(process_handles.0.hThread) } == u32::MAX {
        unsafe { TerminateJobObject(job_handle.0, 1) };
        return Err(win32_error("Could not resume the AppContainer process"));
    }
    let stop_reason = if cancelled_before_resume {
        Some(StopReason::Cancelled)
    } else {
        wait_for_process(
            process_handles.0.hProcess,
            cancellation_event,
            timeout,
            started,
        )?
    };
    if stop_reason.is_some() && unsafe { TerminateJobObject(job_handle.0, 1) } == 0 {
        return Err(win32_error(
            "Could not terminate the AppContainer process job",
        ));
    }
    if stop_reason.is_some() {
        let wait = unsafe { WaitForSingleObject(process_handles.0.hProcess, u32::MAX) };
        if wait != WAIT_OBJECT_0 {
            unsafe { TerminateJobObject(job_handle.0, 1) };
            return Err(win32_error(
                "Waiting for the terminated AppContainer process failed",
            ));
        }
    }
    if unsafe { WaitForSingleObject(process_handles.0.hProcess, 0) } != WAIT_OBJECT_0 {
        unsafe { TerminateJobObject(job_handle.0, 1) };
        return Err("AppContainer process did not reach a completed state".into());
    }
    let mut exit_code = 0u32;
    if unsafe { GetExitCodeProcess(process_handles.0.hProcess, &mut exit_code) } == 0 {
        return Err(win32_error(
            "Could not read the AppContainer process exit code",
        ));
    }
    drop(job_handle);
    drop(process_handles);
    drop(attributes);
    stdin_writer
        .join()
        .map_err(|_| "AppContainer stdin writer thread panicked".to_owned())??;
    let stdout = stdout_reader
        .join()
        .map_err(|_| "AppContainer stdout capture thread panicked".to_owned())??;
    let stderr = stderr_reader
        .join()
        .map_err(|_| "AppContainer stderr capture thread panicked".to_owned())??;
    workspace_grant.restore()?;
    app_container_temp.remove()?;
    profile.remove()?;
    recovery.remove(&journal)?;
    Ok(CommandOutcome {
        exit_code,
        timed_out: stop_reason == Some(StopReason::TimedOut),
        cancelled: stop_reason == Some(StopReason::Cancelled),
        elapsed: started.elapsed(),
        stdout: stdout.bytes,
        stderr: stderr.bytes,
        stdout_truncated: stdout.truncated,
        stderr_truncated: stderr.truncated,
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum StopReason {
    TimedOut,
    Cancelled,
}

#[derive(Debug, Eq, PartialEq)]
pub struct CommandOutcome {
    pub exit_code: u32,
    pub timed_out: bool,
    pub cancelled: bool,
    pub elapsed: Duration,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

#[derive(Debug, Eq, PartialEq)]
struct CapturedStream {
    bytes: Vec<u8>,
    truncated: bool,
}

fn create_inheritable_pipe() -> Result<(OwnedHandle, OwnedHandle), String> {
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: 1,
    };
    let mut read = null_mut();
    let mut write = null_mut();
    if unsafe { CreatePipe(&mut read, &mut write, &attributes, 0) } == 0 {
        return Err(win32_error("Could not create AppContainer stdio pipe"));
    }
    Ok((OwnedHandle(read), OwnedHandle(write)))
}

fn make_noninheritable(handle: &OwnedHandle) -> Result<(), String> {
    if unsafe { SetHandleInformation(handle.0, HANDLE_FLAG_INHERIT, 0) } == 0 {
        return Err(win32_error("Could not secure AppContainer pipe handle"));
    }
    Ok(())
}

fn spawn_stdin_writer(
    handle: OwnedHandle,
    input: Vec<u8>,
) -> Result<std::thread::JoinHandle<Result<(), String>>, String> {
    let file = unsafe { File::from_raw_handle(handle.0 as RawHandle) };
    std::mem::forget(handle);
    std::thread::Builder::new()
        .name("xyst-sandbox-input".into())
        .spawn(move || {
            let mut file = file;
            match file.write_all(&input) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::BrokenPipe => Ok(()),
                Err(error) => Err(format!("Could not forward AppContainer stdin: {error}")),
            }
        })
        .map_err(|error| format!("Could not start AppContainer stdin forwarding: {error}"))
}

fn spawn_capture_reader(
    handle: OwnedHandle,
) -> Result<std::thread::JoinHandle<Result<CapturedStream, String>>, String> {
    let file = unsafe { File::from_raw_handle(handle.0 as RawHandle) };
    std::mem::forget(handle);
    std::thread::Builder::new()
        .name("xyst-sandbox-output".into())
        .spawn(move || {
            let mut file = file;
            let mut bytes = Vec::with_capacity(MAX_CAPTURED_STREAM_BYTES.min(16 * 1024));
            let mut truncated = false;
            let mut buffer = [0u8; 16 * 1024];
            loop {
                let count = file
                    .read(&mut buffer)
                    .map_err(|error| format!("Could not capture AppContainer output: {error}"))?;
                if count == 0 {
                    break;
                }
                let kept = count.min(MAX_CAPTURED_STREAM_BYTES.saturating_sub(bytes.len()));
                bytes.extend_from_slice(&buffer[..kept]);
                truncated |= kept < count;
            }
            Ok(CapturedStream { bytes, truncated })
        })
        .map_err(|error| format!("Could not start AppContainer output capture: {error}"))
}

fn wait_for_process(
    process: HANDLE,
    cancellation_event: Option<HANDLE>,
    timeout: Duration,
    started: Instant,
) -> Result<Option<StopReason>, String> {
    let remaining = timeout.saturating_sub(started.elapsed());
    if remaining.is_zero() {
        return Ok(Some(StopReason::TimedOut));
    }
    let wait_ms = remaining.as_millis().clamp(1, u32::MAX as u128 - 1) as u32;
    let result = if let Some(event) = cancellation_event {
        let handles = [process, event];
        unsafe { WaitForMultipleObjects(handles.len() as u32, handles.as_ptr(), 0, wait_ms) }
    } else {
        unsafe { WaitForSingleObject(process, wait_ms) }
    };
    if result == WAIT_OBJECT_0 {
        return Ok(None);
    }
    if cancellation_event.is_some() && result == WAIT_OBJECT_0 + 1 {
        return Ok(Some(StopReason::Cancelled));
    }
    if result == WAIT_TIMEOUT {
        return Ok(Some(StopReason::TimedOut));
    }
    if result == WAIT_FAILED {
        return Err(win32_error("Waiting for the AppContainer process failed"));
    }
    Err(format!("Unexpected AppContainer wait result {result}"))
}

fn canonical_workspace(path: &Path) -> Result<PathBuf, String> {
    let canonical = std::fs::canonicalize(path).map_err(|error| {
        format!(
            "Could not resolve AppContainer workspace {}: {error}",
            path.display()
        )
    })?;
    let display = canonical.to_string_lossy();
    let normalized = display.to_ascii_lowercase();
    if canonical.parent().is_none()
        || normalized.starts_with(r"\\?\unc\")
        || normalized.starts_with(r"\\") && !normalized.starts_with(r"\\?\")
    {
        return Err("AppContainer workspace cannot be a filesystem root or UNC path".into());
    }
    Ok(canonical)
}

fn is_within_workspace(root: &Path, target: &Path) -> bool {
    let root = strip_extended_prefix(root)
        .to_string_lossy()
        .trim_end_matches(['\\', '/'])
        .to_lowercase();
    let target = strip_extended_prefix(target)
        .to_string_lossy()
        .to_lowercase();
    target == root
        || target
            .strip_prefix(&root)
            .is_some_and(|suffix| suffix.starts_with(['\\', '/']))
}

fn strip_extended_prefix(path: &Path) -> PathBuf {
    let value = path.to_string_lossy();
    if let Some(path) = value.strip_prefix(r"\\?\") {
        PathBuf::from(path)
    } else {
        path.to_owned()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
struct WorkspaceIdentity {
    volume_serial: u32,
    file_index: u64,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct RecoveryRecord {
    version: u32,
    profile_identity: String,
    sid: String,
    workspace_path: String,
    workspace_identity: WorkspaceIdentity,
    #[serde(default)]
    agent_state_dacl: Option<Vec<u8>>,
    #[serde(default)]
    agent_state_identity: Option<WorkspaceIdentity>,
}

struct SandboxRecovery {
    directory: PathBuf,
    _lock: File,
}

impl SandboxRecovery {
    fn open(local_app_data: &Path) -> Result<Self, String> {
        if !local_app_data.is_absolute() {
            return Err("LOCALAPPDATA for sandbox recovery must be an absolute path".into());
        }
        let mut current = local_app_data.to_owned();
        loop {
            let metadata = std::fs::symlink_metadata(&current).map_err(|error| {
                format!("Could not inspect LOCALAPPDATA recovery path: {error}")
            })?;
            if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            {
                return Err(
                    "LOCALAPPDATA for sandbox recovery must contain only real directories".into(),
                );
            }
            let Some(parent) = current.parent() else {
                break;
            };
            if parent == current {
                break;
            }
            current = parent.to_owned();
        }
        let local_app_data = std::fs::canonicalize(local_app_data).map_err(|error| {
            format!("Could not resolve LOCALAPPDATA for sandbox recovery: {error}")
        })?;
        let app_directory = ensure_real_child_directory(&local_app_data, "Xyst AI Assistant")?;
        let directory = ensure_real_child_directory(&app_directory, "SandboxRecovery")?;
        let lock_path = directory.join("recovery.lock");
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .share_mode(0)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(&lock_path)
            .map_err(|error| format!("Could not lock sandbox recovery state: {error}"))?;
        if lock
            .metadata()
            .map_err(|error| format!("Could not inspect sandbox recovery lock: {error}"))?
            .file_attributes()
            & FILE_ATTRIBUTE_REPARSE_POINT
            != 0
        {
            return Err("Sandbox recovery lock cannot be a reparse point".into());
        }
        Ok(Self {
            directory,
            _lock: lock,
        })
    }

    fn write(&self, record: RecoveryRecord) -> Result<PathBuf, String> {
        let mut random = [0u8; 16];
        getrandom::fill(&mut random)
            .map_err(|error| format!("Could not create sandbox recovery record ID: {error}"))?;
        let id = hex(&random);
        self.write_with_id(record, &id)
    }

    fn write_with_id(&self, record: RecoveryRecord, id: &str) -> Result<PathBuf, String> {
        if !is_recovery_id(id) {
            return Err("Sandbox recovery record ID is invalid".into());
        }
        let temporary_path = self.directory.join(format!(".{id}.tmp"));
        let journal_path = self.directory.join(format!("{id}.json"));
        let contents = serde_json::to_vec(&record)
            .map_err(|error| format!("Could not encode sandbox recovery record: {error}"))?;
        if contents.len() as u64 > MAX_RECOVERY_RECORD_BYTES {
            return Err("Sandbox recovery record exceeds its size limit".into());
        }
        let mut created_temporary = false;
        let result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary_path)
                .map_err(|error| format!("Could not create sandbox recovery record: {error}"))?;
            created_temporary = true;
            file.write_all(&contents)
                .and_then(|()| file.sync_all())
                .map_err(|error| format!("Could not flush sandbox recovery record: {error}"))?;
            drop(file);
            let temporary_wide = temporary_path
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect::<Vec<_>>();
            let journal_wide = journal_path
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect::<Vec<_>>();
            if unsafe {
                MoveFileExW(
                    temporary_wide.as_ptr(),
                    journal_wide.as_ptr(),
                    MOVEFILE_WRITE_THROUGH,
                )
            } == 0
            {
                return Err(win32_error("Could not commit sandbox recovery record"));
            }
            Ok(journal_path.clone())
        })();
        if result.is_err() && created_temporary {
            let _ = std::fs::remove_file(&temporary_path);
        }
        result
    }

    fn recover(&self) -> Result<(), String> {
        let entries = std::fs::read_dir(&self.directory)
            .map_err(|error| format!("Could not list sandbox recovery records: {error}"))?;
        let mut records = Vec::new();
        for entry in entries {
            let entry = entry
                .map_err(|error| format!("Could not inspect sandbox recovery record: {error}"))?;
            if entry
                .file_name()
                .to_str()
                .is_some_and(is_recovery_temporary_record)
            {
                let path = entry.path();
                let metadata = std::fs::symlink_metadata(&path).map_err(|error| {
                    format!("Could not inspect temporary sandbox recovery record: {error}")
                })?;
                if !metadata.is_file()
                    || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
                {
                    return Err("Temporary sandbox recovery record is not a regular file".into());
                }
                std::fs::remove_file(path).map_err(|error| {
                    format!("Could not remove interrupted sandbox recovery record: {error}")
                })?;
                continue;
            }
            if entry
                .path()
                .extension()
                .is_some_and(|extension| extension == "json")
            {
                records.push(entry.path());
            }
        }
        records.sort();
        for path in records {
            let file = OpenOptions::new()
                .read(true)
                .share_mode(0)
                .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
                .open(&path)
                .map_err(|error| format!("Could not open sandbox recovery record: {error}"))?;
            let metadata = file
                .metadata()
                .map_err(|error| format!("Could not inspect sandbox recovery record: {error}"))?;
            if !metadata.is_file()
                || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
                || metadata.len() > MAX_RECOVERY_RECORD_BYTES
            {
                return Err("Sandbox recovery record is not a bounded regular file".into());
            }
            let mut bytes = Vec::with_capacity(metadata.len() as usize);
            file.take(MAX_RECOVERY_RECORD_BYTES + 1)
                .read_to_end(&mut bytes)
                .map_err(|error| format!("Could not read sandbox recovery record: {error}"))?;
            if bytes.len() as u64 > MAX_RECOVERY_RECORD_BYTES {
                return Err("Sandbox recovery record exceeds its size limit".into());
            }
            let record: RecoveryRecord = serde_json::from_slice(&bytes).map_err(|error| {
                format!("Sandbox recovery record is invalid; refusing to launch: {error}")
            })?;
            validate_recovery_record(&record)?;
            let workspace = canonical_workspace(Path::new(&record.workspace_path))?;
            if !windows_paths_equal(&workspace, Path::new(&record.workspace_path)) {
                return Err("Sandbox recovery workspace path changed; refusing to launch".into());
            }
            let current_identity = capture_workspace_identity(&workspace)?;
            if current_identity != record.workspace_identity {
                return Err(
                    "Sandbox recovery workspace identity changed; refusing to alter permissions"
                        .into(),
                );
            }
            let sid_string: Vec<u16> = record
                .sid
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect();
            let mut sid = null_mut();
            if unsafe { ConvertStringSidToSidW(sid_string.as_ptr(), &mut sid) } == 0
                || sid.is_null()
            {
                return Err(win32_error(
                    "Could not parse sandbox recovery AppContainer SID",
                ));
            }
            let profile_identity: Vec<u16> = record
                .profile_identity
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect();
            let mut derived_sid = null_mut();
            let derive_status = unsafe {
                DeriveAppContainerSidFromAppContainerName(
                    profile_identity.as_ptr(),
                    &mut derived_sid,
                )
            };
            if derive_status < 0 || derived_sid.is_null() {
                unsafe { LocalFree(sid.cast()) };
                return Err(format!(
                    "Could not verify sandbox recovery AppContainer identity (HRESULT 0x{:08X})",
                    derive_status as u32
                ));
            }
            let sid_matches_profile = unsafe { EqualSid(sid, derived_sid) != 0 };
            unsafe { FreeSid(derived_sid) };
            if !sid_matches_profile {
                unsafe { LocalFree(sid.cast()) };
                return Err("Sandbox recovery SID does not match its AppContainer profile".into());
            }
            let result = restore_workspace_acl(
                &workspace,
                sid,
                current_identity,
                record.agent_state_dacl.as_deref(),
                record.agent_state_identity,
            );
            unsafe { LocalFree(sid.cast()) };
            result?;
            let status = unsafe { DeleteAppContainerProfile(profile_identity.as_ptr()) };
            if status < 0 {
                return Err(format!(
                    "Could not remove recovered AppContainer profile (HRESULT 0x{:08X})",
                    status as u32
                ));
            }
            std::fs::remove_file(&path).map_err(|error| {
                format!("Could not remove completed sandbox recovery record: {error}")
            })?;
        }
        Ok(())
    }

    fn remove(&self, path: &Path) -> Result<(), String> {
        std::fs::remove_file(path)
            .map_err(|error| format!("Could not remove completed sandbox recovery record: {error}"))
    }
}

fn is_recovery_temporary_record(name: &str) -> bool {
    name.strip_prefix('.')
        .and_then(|name| name.strip_suffix(".tmp"))
        .is_some_and(is_recovery_id)
}

fn is_recovery_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn ensure_real_child_directory(parent: &Path, name: &str) -> Result<PathBuf, String> {
    let directory = parent.join(name);
    match std::fs::symlink_metadata(&directory) {
        Ok(metadata) => {
            if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            {
                return Err(format!(
                    "Sandbox state directory must be a real directory: {name}"
                ));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir(&directory).map_err(|error| {
                format!("Could not create sandbox state directory {name}: {error}")
            })?;
            let metadata = std::fs::symlink_metadata(&directory).map_err(|error| {
                format!("Could not inspect sandbox state directory {name}: {error}")
            })?;
            if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            {
                return Err(format!(
                    "Sandbox state directory must be a real directory: {name}"
                ));
            }
        }
        Err(error) => {
            return Err(format!(
                "Could not inspect sandbox state directory {name}: {error}"
            ));
        }
    }
    Ok(directory)
}

fn validate_recovery_record(record: &RecoveryRecord) -> Result<(), String> {
    let suffix = record.profile_identity.strip_prefix(PROFILE_PREFIX);
    if !matches!(record.version, 1..=3)
        || (record.version == 1 && record.agent_state_dacl.is_some())
        || (record.version < 3 && record.agent_state_identity.is_some())
        || (matches!(record.version, 2 | 3)
            && record
                .agent_state_dacl
                .as_ref()
                .is_none_or(|dacl| !is_valid_saved_agent_state_dacl(dacl)))
        || (record.version == 3 && record.agent_state_identity.is_none())
        || !suffix.is_some_and(|value| {
            value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
        || record.sid.len() > 184
        || !record.sid.starts_with("S-1-15-2-")
        || !Path::new(&record.workspace_path).is_absolute()
    {
        return Err("Sandbox recovery record fields are invalid; refusing to launch".into());
    }
    Ok(())
}

fn is_valid_saved_agent_state_dacl(dacl: &[u8]) -> bool {
    if dacl.is_empty() {
        return true;
    }
    dacl.len() <= MAX_AGENT_STATE_DACL_BYTES
        && dacl.len() >= 8
        && matches!(dacl[0], 2 | 4)
        && usize::from(u16::from_le_bytes([dacl[2], dacl[3]])) == dacl.len()
}

fn sid_to_string(sid: windows_sys::Win32::Security::PSID) -> Result<String, String> {
    let mut sid_string = null_mut();
    if unsafe { ConvertSidToStringSidW(sid, &mut sid_string) } == 0 || sid_string.is_null() {
        return Err(win32_error("Could not format the AppContainer SID"));
    }
    let mut length = 0;
    unsafe {
        while *sid_string.add(length) != 0 {
            length += 1;
        }
    }
    let value = unsafe {
        OsString::from_wide(std::slice::from_raw_parts(sid_string, length))
            .to_string_lossy()
            .into_owned()
    };
    unsafe { LocalFree(sid_string.cast()) };
    Ok(value)
}

fn windows_paths_equal(left: &Path, right: &Path) -> bool {
    strip_extended_prefix(left)
        .to_string_lossy()
        .eq_ignore_ascii_case(&strip_extended_prefix(right).to_string_lossy())
}

fn contains_agent_state_segment(path: &Path) -> bool {
    path.components().any(|component| {
        component
            .as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(".agent")
    })
}

struct WorkspaceAclGrant {
    handle: OwnedHandle,
    _agent_state_handle: Option<OwnedHandle>,
    agent_state_path: PathBuf,
    agent_state_identity: WorkspaceIdentity,
    original_agent_state_dacl: Vec<u8>,
    sid: windows_sys::Win32::Security::PSID,
    identity: WorkspaceIdentity,
    active: bool,
}

impl WorkspaceAclGrant {
    fn apply(
        path: &Path,
        sid: windows_sys::Win32::Security::PSID,
        expected_identity: WorkspaceIdentity,
        read_only: bool,
        original_agent_state_dacl: Vec<u8>,
    ) -> Result<Self, String> {
        let canonical = canonical_workspace(path)?;
        if contains_agent_state_segment(&canonical) {
            return Err(
                "Xyst state directories cannot be used as an AppContainer workspace".into(),
            );
        }
        validate_workspace_tree(&canonical)?;
        let agent_state_path = ensure_real_child_directory(&canonical, ".agent")?;
        validate_workspace_tree(&canonical)?;
        if capture_agent_state_dacl(&agent_state_path)? != original_agent_state_dacl {
            return Err("Xyst state permissions changed before AppContainer isolation".into());
        }
        let agent_state_identity = capture_workspace_identity(&agent_state_path)?;
        let wide_path = canonical
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let handle = unsafe {
            CreateFileW(
                wide_path.as_ptr(),
                READ_CONTROL | WRITE_DAC | FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(win32_error("Could not open the AppContainer workspace"));
        }
        let handle = OwnedHandle(handle);
        let identity = workspace_identity(handle.0)?;
        if identity != expected_identity {
            return Err("Workspace identity changed before AppContainer permission grant".into());
        }
        let mut dacl = null_mut();
        let mut descriptor = null_mut();
        let status = unsafe {
            GetSecurityInfo(
                handle.0,
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                &mut dacl,
                null_mut(),
                &mut descriptor,
            )
        };
        if status != 0 {
            return Err(format!(
                "Could not read workspace permissions (Windows error {status})"
            ));
        }
        let mut access = EXPLICIT_ACCESS_W {
            grfAccessPermissions: if read_only {
                WORKSPACE_READ_ONLY_ACCESS
            } else {
                WORKSPACE_ACCESS
            },
            grfAccessMode: GRANT_ACCESS,
            grfInheritance: OBJECT_INHERIT_ACE
                | windows_sys::Win32::Security::CONTAINER_INHERIT_ACE,
            ..Default::default()
        };
        unsafe { BuildTrusteeWithSidW(&mut access.Trustee, sid) };
        let mut updated_dacl = null_mut();
        let status = unsafe { SetEntriesInAclW(1, &access, dacl, &mut updated_dacl) };
        if status == 0 && !read_only {
            let mut child_delete = EXPLICIT_ACCESS_W {
                grfAccessPermissions: FILE_DELETE_CHILD,
                grfAccessMode: GRANT_ACCESS,
                grfInheritance: OBJECT_INHERIT_ACE
                    | windows_sys::Win32::Security::CONTAINER_INHERIT_ACE
                    | INHERIT_ONLY_ACE,
                ..Default::default()
            };
            unsafe { BuildTrusteeWithSidW(&mut child_delete.Trustee, sid) };
            let mut with_child_delete = null_mut();
            let child_status =
                unsafe { SetEntriesInAclW(1, &child_delete, updated_dacl, &mut with_child_delete) };
            unsafe { LocalFree(updated_dacl.cast()) };
            if child_status == 0 {
                updated_dacl = with_child_delete;
            } else {
                if !descriptor.is_null() {
                    unsafe { LocalFree(descriptor.cast()) };
                }
                return Err(format!(
                    "Could not prepare workspace deletion permissions (Windows error {child_status})"
                ));
            }
        }
        if !descriptor.is_null() {
            unsafe { LocalFree(descriptor.cast()) };
        }
        if status != 0 || updated_dacl.is_null() {
            return Err(format!(
                "Could not prepare workspace permissions (Windows error {status})"
            ));
        }
        let mut grant = Self {
            handle,
            _agent_state_handle: None,
            agent_state_path: agent_state_path.clone(),
            agent_state_identity,
            original_agent_state_dacl,
            sid,
            identity,
            active: true,
        };
        let status = unsafe {
            SetSecurityInfo(
                grant.handle.0,
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                updated_dacl,
                null_mut(),
            )
        };
        unsafe { LocalFree(updated_dacl.cast()) };
        if status != 0 {
            return Err(format!(
                "Could not grant AppContainer workspace access (Windows error {status})"
            ));
        }
        grant._agent_state_handle = Some(set_agent_state_deny(
            &agent_state_path,
            sid,
            agent_state_identity,
        )?);
        Ok(grant)
    }

    fn restore(mut self) -> Result<(), String> {
        self.restore_inner()?;
        self.active = false;
        Ok(())
    }

    fn restore_inner(&self) -> Result<(), String> {
        if workspace_identity(self.handle.0)? != self.identity {
            return Err("Workspace identity changed before AppContainer permission cleanup".into());
        }
        restore_workspace_acl_on_handle(self.handle.0, self.sid)?;
        restore_agent_state_acl(
            &self.agent_state_path,
            &self.original_agent_state_dacl,
            Some(self.agent_state_identity),
        )
    }
}

impl Drop for WorkspaceAclGrant {
    fn drop(&mut self) {
        if self.active {
            let _ = self.restore_inner();
        }
    }
}

fn workspace_identity(handle: HANDLE) -> Result<WorkspaceIdentity, String> {
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    if unsafe { GetFileInformationByHandle(handle, &mut info) } == 0 {
        return Err(win32_error("Could not inspect the AppContainer workspace"));
    }
    if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
        || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        return Err("AppContainer workspace must be a real directory, not a reparse point".into());
    }
    Ok(WorkspaceIdentity {
        volume_serial: info.dwVolumeSerialNumber,
        file_index: (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
    })
}

fn capture_workspace_identity(path: &Path) -> Result<WorkspaceIdentity, String> {
    let canonical = canonical_workspace(path)?;
    let wide_path = canonical
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let handle = unsafe {
        CreateFileW(
            wide_path.as_ptr(),
            READ_CONTROL | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(win32_error(
            "Could not open workspace for recovery identity",
        ));
    }
    let handle = OwnedHandle(handle);
    workspace_identity(handle.0)
}

fn restore_workspace_acl(
    path: &Path,
    sid: windows_sys::Win32::Security::PSID,
    identity: WorkspaceIdentity,
    agent_state_dacl: Option<&[u8]>,
    agent_state_identity: Option<WorkspaceIdentity>,
) -> Result<(), String> {
    let canonical = canonical_workspace(path)?;
    let wide_path = canonical
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let handle = unsafe {
        CreateFileW(
            wide_path.as_ptr(),
            READ_CONTROL | WRITE_DAC | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(win32_error(
            "Could not open workspace for permission recovery",
        ));
    }
    let handle = OwnedHandle(handle);
    if workspace_identity(handle.0)? != identity {
        return Err("Workspace identity changed before sandbox permission recovery".into());
    }
    restore_workspace_acl_on_handle(handle.0, sid)?;
    if let Some(agent_state_dacl) = agent_state_dacl {
        let state_path = canonical.join(".agent");
        restore_agent_state_acl(&state_path, agent_state_dacl, agent_state_identity)?;
    }
    Ok(())
}

fn capture_agent_state_dacl(path: &Path) -> Result<Vec<u8>, String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("Could not inspect the Xyst state directory: {error}"))?;
    if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err("Xyst state path must be a real directory".into());
    }
    let wide_path = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let handle = unsafe {
        CreateFileW(
            wide_path.as_ptr(),
            READ_CONTROL | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(win32_error("Could not open the Xyst state directory"));
    }
    let handle = OwnedHandle(handle);
    let mut dacl = null_mut();
    let mut descriptor = null_mut();
    let status = unsafe {
        GetSecurityInfo(
            handle.0,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut dacl,
            null_mut(),
            &mut descriptor,
        )
    };
    if status != 0 {
        return Err(format!(
            "Could not read Xyst state permissions (Windows error {status})"
        ));
    }
    let bytes = if dacl.is_null() {
        Vec::new()
    } else {
        let size = unsafe { (*dacl.cast::<windows_sys::Win32::Security::ACL>()).AclSize as usize };
        if size > MAX_AGENT_STATE_DACL_BYTES {
            if !descriptor.is_null() {
                unsafe { LocalFree(descriptor.cast()) };
            }
            return Err("Xyst state permissions exceed the recovery record limit".into());
        }
        unsafe { std::slice::from_raw_parts(dacl.cast::<u8>(), size) }.to_vec()
    };
    if !descriptor.is_null() {
        unsafe { LocalFree(descriptor.cast()) };
    }
    if !is_valid_saved_agent_state_dacl(&bytes) {
        return Err("Xyst state permissions have an invalid ACL encoding".into());
    }
    Ok(bytes)
}

fn set_agent_state_deny(
    path: &Path,
    sid: windows_sys::Win32::Security::PSID,
    expected_identity: WorkspaceIdentity,
) -> Result<OwnedHandle, String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        format!("Could not inspect the AppContainer-protected state directory: {error}")
    })?;
    if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err("AppContainer-protected state path must be a real directory".into());
    }
    let wide_path = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let handle = unsafe {
        CreateFileW(
            wide_path.as_ptr(),
            READ_CONTROL | WRITE_DAC | FILE_READ_ATTRIBUTES,
            // Keep delete sharing disabled for the lifetime of the grant. This
            // pins the protected directory so it cannot be renamed and replaced
            // with a fresh directory that inherits the workspace allow ACE.
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(win32_error(
            "Could not open the AppContainer-protected state directory",
        ));
    }
    let handle = OwnedHandle(handle);
    if workspace_identity(handle.0)? != expected_identity {
        return Err("Xyst state directory changed before AppContainer protection".into());
    }
    let mut dacl = null_mut();
    let mut descriptor = null_mut();
    let status = unsafe {
        GetSecurityInfo(
            handle.0,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut dacl,
            null_mut(),
            &mut descriptor,
        )
    };
    if status != 0 {
        return Err(format!(
            "Could not read protected state permissions (Windows error {status})"
        ));
    }
    let mut deny = EXPLICIT_ACCESS_W {
        grfAccessPermissions: WORKSPACE_ACCESS | FILE_DELETE_CHILD,
        grfAccessMode: DENY_ACCESS,
        grfInheritance: OBJECT_INHERIT_ACE | windows_sys::Win32::Security::CONTAINER_INHERIT_ACE,
        ..Default::default()
    };
    unsafe { BuildTrusteeWithSidW(&mut deny.Trustee, sid) };
    let mut updated_dacl = null_mut();
    let status = unsafe { SetEntriesInAclW(1, &deny, dacl, &mut updated_dacl) };
    if !descriptor.is_null() {
        unsafe { LocalFree(descriptor.cast()) };
    }
    if status != 0 || updated_dacl.is_null() {
        return Err(format!(
            "Could not prepare protected state permissions (Windows error {status})"
        ));
    }
    let status = unsafe {
        SetSecurityInfo(
            handle.0,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            updated_dacl,
            null_mut(),
        )
    };
    unsafe { LocalFree(updated_dacl.cast()) };
    if status != 0 {
        return Err(format!(
            "Could not protect Xyst state from AppContainer access (Windows error {status})"
        ));
    }
    Ok(handle)
}

fn restore_agent_state_acl(
    path: &Path,
    original_dacl: &[u8],
    expected_identity: Option<WorkspaceIdentity>,
) -> Result<(), String> {
    if !is_valid_saved_agent_state_dacl(original_dacl) {
        return Err("Saved Xyst state permissions exceed the recovery limit".into());
    }
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Could not inspect protected state during cleanup: {error}"
            ))
        }
    };
    if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err("Refusing to restore permissions through a replaced Xyst state path".into());
    }
    let wide_path = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let handle = unsafe {
        CreateFileW(
            wide_path.as_ptr(),
            READ_CONTROL | WRITE_DAC | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(win32_error("Could not open protected state during cleanup"));
    }
    let handle = OwnedHandle(handle);
    if let Some(expected_identity) = expected_identity {
        if workspace_identity(handle.0)? != expected_identity {
            return Err(
                "Xyst state directory identity changed before sandbox ACL restoration".into(),
            );
        }
    } else {
        workspace_identity(handle.0)?;
    }
    let mut aligned_dacl = vec![0u64; original_dacl.len().div_ceil(size_of::<u64>())];
    if !original_dacl.is_empty() {
        unsafe {
            std::ptr::copy_nonoverlapping(
                original_dacl.as_ptr(),
                aligned_dacl.as_mut_ptr().cast::<u8>(),
                original_dacl.len(),
            );
        }
    }
    let dacl = if aligned_dacl.is_empty() {
        null_mut()
    } else {
        aligned_dacl.as_mut_ptr().cast()
    };
    let status = unsafe {
        SetSecurityInfo(
            handle.0,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | UNPROTECTED_DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            dacl,
            null_mut(),
        )
    };
    if status != 0 {
        return Err(format!(
            "Could not restore original Xyst state permissions (Windows error {status})"
        ));
    }
    Ok(())
}

fn restore_workspace_acl_on_handle(
    handle: HANDLE,
    sid: windows_sys::Win32::Security::PSID,
) -> Result<(), String> {
    let mut dacl = null_mut();
    let mut descriptor = null_mut();
    let status = unsafe {
        GetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut dacl,
            null_mut(),
            &mut descriptor,
        )
    };
    if status != 0 {
        return Err(format!(
            "Could not read workspace permissions for cleanup (Windows error {status})"
        ));
    }
    let mut access = EXPLICIT_ACCESS_W {
        grfAccessMode: REVOKE_ACCESS,
        ..Default::default()
    };
    unsafe { BuildTrusteeWithSidW(&mut access.Trustee, sid) };
    let mut updated_dacl = null_mut();
    let status = unsafe { SetEntriesInAclW(1, &access, dacl, &mut updated_dacl) };
    if !descriptor.is_null() {
        unsafe { LocalFree(descriptor.cast()) };
    }
    if status != 0 || updated_dacl.is_null() {
        return Err(format!(
            "Could not prepare workspace permission cleanup (Windows error {status})"
        ));
    }
    let status = unsafe {
        SetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            updated_dacl,
            null_mut(),
        )
    };
    unsafe { LocalFree(updated_dacl.cast()) };
    if status != 0 {
        return Err(format!(
            "Could not restore workspace permissions (Windows error {status})"
        ));
    }
    Ok(())
}

fn validate_workspace_tree(root: &Path) -> Result<(), String> {
    let mut pending = vec![root.to_owned()];
    while let Some(directory) = pending.pop() {
        let entries = std::fs::read_dir(&directory).map_err(|error| {
            format!("Could not inspect AppContainer workspace contents: {error}")
        })?;
        for entry in entries {
            let entry = entry.map_err(|error| {
                format!("Could not inspect AppContainer workspace entry: {error}")
            })?;
            let entry_path = entry.path();
            let metadata = std::fs::symlink_metadata(&entry_path).map_err(|error| {
                format!("Could not inspect AppContainer workspace entry: {error}")
            })?;
            if metadata.file_type().is_symlink()
                || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            {
                return Err(format!(
                    "AppContainer workspace contains a reparse point: {}",
                    entry_path.display()
                ));
            }
            validate_inherited_workspace_permissions(&entry_path, metadata.is_dir())?;
            if metadata.is_dir() {
                pending.push(entry_path);
                continue;
            }
            if !metadata.is_file() {
                return Err(format!(
                    "AppContainer workspace contains an unsupported filesystem object: {}",
                    entry_path.display()
                ));
            }
            let wide_path = entry_path
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect::<Vec<_>>();
            let handle = unsafe {
                CreateFileW(
                    wide_path.as_ptr(),
                    FILE_READ_ATTRIBUTES,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    null(),
                    OPEN_EXISTING,
                    FILE_FLAG_OPEN_REPARSE_POINT,
                    null_mut(),
                )
            };
            if handle == INVALID_HANDLE_VALUE {
                return Err(win32_error(
                    "Could not open an AppContainer workspace file for validation",
                ));
            }
            let handle = OwnedHandle(handle);
            let mut info = BY_HANDLE_FILE_INFORMATION::default();
            if unsafe { GetFileInformationByHandle(handle.0, &mut info) } == 0 {
                return Err(win32_error(
                    "Could not inspect an AppContainer workspace file",
                ));
            }
            if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return Err(format!(
                    "AppContainer workspace contains a reparse point: {}",
                    entry_path.display()
                ));
            }
            validate_workspace_link_count(&entry_path, info.nNumberOfLinks)?;
        }
    }
    Ok(())
}

fn validate_inherited_workspace_permissions(path: &Path, is_directory: bool) -> Result<(), String> {
    let wide_path = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let handle = unsafe {
        CreateFileW(
            wide_path.as_ptr(),
            READ_CONTROL,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            null(),
            OPEN_EXISTING,
            if is_directory {
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT
            } else {
                FILE_FLAG_OPEN_REPARSE_POINT
            },
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(win32_error(
            "Could not inspect AppContainer workspace permission inheritance",
        ));
    }
    let handle = OwnedHandle(handle);
    let mut dacl = null_mut();
    let mut descriptor = null_mut();
    let status = unsafe {
        GetSecurityInfo(
            handle.0,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut dacl,
            null_mut(),
            &mut descriptor,
        )
    };
    if status != 0 {
        return Err(format!(
            "Could not inspect AppContainer workspace permission inheritance (Windows error {status})"
        ));
    }
    if descriptor.is_null() {
        return Err("Could not inspect AppContainer workspace permission inheritance".into());
    }
    let mut control = 0u16;
    let mut revision = 0u32;
    let control_status =
        unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) };
    if !descriptor.is_null() {
        unsafe { LocalFree(descriptor.cast()) };
    }
    if control_status == 0 {
        return Err(win32_error(
            "Could not inspect AppContainer workspace permission inheritance",
        ));
    }
    if control & SE_DACL_PROTECTED != 0 {
        return Err(format!(
            "AppContainer workspace contains an item with protected permissions: {}",
            path.display()
        ));
    }
    Ok(())
}

fn validate_workspace_link_count(path: &Path, links: u32) -> Result<(), String> {
    if links > 1 {
        return Err(format!(
            "AppContainer workspace contains a hard-linked file: {}",
            path.display()
        ));
    }
    Ok(())
}

const INVALID_HANDLE_VALUE: HANDLE = -1isize as HANDLE;

pub fn quote_windows_argument(value: &str) -> String {
    if !value.is_empty() && !value.chars().any(|ch| ch.is_whitespace() || ch == '"') {
        return value.to_owned();
    }
    let mut quoted = String::from("\"");
    let mut backslashes = 0;
    for ch in value.chars() {
        match ch {
            '\\' => backslashes += 1,
            '"' => {
                quoted.push_str(&"\\".repeat(backslashes * 2 + 1));
                quoted.push('"');
                backslashes = 0;
            }
            _ => {
                quoted.push_str(&"\\".repeat(backslashes));
                quoted.push(ch);
                backslashes = 0;
            }
        }
    }
    quoted.push_str(&"\\".repeat(backslashes * 2));
    quoted.push('"');
    quoted
}

fn build_command_line(executable: &Path, args: &[String]) -> Result<String, String> {
    if !executable.is_absolute() {
        return Err("AppContainer executable must be an absolute path".into());
    }
    let mut values = Vec::with_capacity(args.len() + 1);
    values.push(executable.to_string_lossy().into_owned());
    values.extend(args.iter().cloned());
    let command_line = values
        .iter()
        .map(|value| quote_windows_argument(value))
        .collect::<Vec<_>>()
        .join(" ");
    if command_line.encode_utf16().count() >= MAX_COMMAND_LINE_UNITS {
        return Err("AppContainer command line exceeds the Windows limit".into());
    }
    Ok(command_line)
}

fn build_environment_block(environment: &BTreeMap<String, String>) -> Result<Vec<u16>, String> {
    let mut entries = Vec::with_capacity(environment.len());
    let mut seen_keys = std::collections::BTreeSet::new();
    for (key, value) in environment {
        if key.is_empty() || key.contains(['=', '\0']) || value.contains('\0') {
            return Err("AppContainer environment contains an invalid entry".into());
        }
        if !seen_keys.insert(key.to_lowercase()) {
            return Err("AppContainer environment contains duplicate keys".into());
        }
        entries.push(format!("{key}={value}"));
    }
    entries.sort_by_key(|entry| entry.to_lowercase());
    let joined = entries.join("\0");
    let mut block = joined.encode_utf16().collect::<Vec<_>>();
    block.extend([0, 0]);
    if block.len() > MAX_ENVIRONMENT_UNITS {
        return Err("AppContainer environment exceeds the Windows limit".into());
    }
    Ok(block)
}

fn environment_value<'a>(environment: &'a BTreeMap<String, String>, name: &str) -> Option<&'a str> {
    environment
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn win32_error(message: &str) -> String {
    format!("{message} (Windows error {})", unsafe { GetLastError() })
}

struct AppContainerProfile {
    identity: Vec<u16>,
    sid: windows_sys::Win32::Security::PSID,
}

impl AppContainerProfile {
    fn create(name: &str) -> Result<Self, String> {
        let identity: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        let mut sid = null_mut();
        let result = unsafe {
            CreateAppContainerProfile(
                identity.as_ptr(),
                identity.as_ptr(),
                identity.as_ptr(),
                null(),
                0,
                &mut sid,
            )
        };
        if result < 0 || sid.is_null() {
            return Err(format!(
                "Could not create a Windows AppContainer profile (HRESULT 0x{:08X})",
                result as u32
            ));
        }
        Ok(Self { identity, sid })
    }

    fn remove(&mut self) -> Result<(), String> {
        if self.sid.is_null() {
            return Ok(());
        }
        let result = unsafe { DeleteAppContainerProfile(self.identity.as_ptr()) };
        if result < 0 {
            return Err(format!(
                "Could not remove the temporary AppContainer profile (HRESULT 0x{:08X})",
                result as u32
            ));
        }
        unsafe { FreeSid(self.sid) };
        self.sid = null_mut();
        Ok(())
    }

    fn local_data_path(&self) -> Result<PathBuf, String> {
        let sid_string = sid_to_string(self.sid)?;
        let sid_string_wide = sid_string
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let mut folder_path = null_mut();
        let result =
            unsafe { GetAppContainerFolderPath(sid_string_wide.as_ptr(), &mut folder_path) };
        if result < 0 || folder_path.is_null() {
            if !folder_path.is_null() {
                unsafe { CoTaskMemFree(folder_path.cast()) };
            }
            return Err(format!(
                "Could not resolve the AppContainer local-data folder (HRESULT 0x{:08X})",
                result as u32
            ));
        }
        let path = unsafe {
            let mut length = 0;
            while *folder_path.add(length) != 0 {
                length += 1;
            }
            PathBuf::from(OsString::from_wide(std::slice::from_raw_parts(
                folder_path,
                length,
            )))
        };
        unsafe { CoTaskMemFree(folder_path.cast()) };
        if !path.is_absolute() {
            return Err("Windows returned a non-absolute AppContainer local-data path".into());
        }
        Ok(path)
    }
}

impl Drop for AppContainerProfile {
    fn drop(&mut self) {
        if !self.sid.is_null() {
            unsafe {
                let _ = DeleteAppContainerProfile(self.identity.as_ptr());
                FreeSid(self.sid);
            }
            self.sid = null_mut();
        }
    }
}

struct AttributeList(*mut c_void);

impl Drop for AttributeList {
    fn drop(&mut self) {
        unsafe { DeleteProcThreadAttributeList(self.0) };
    }
}

struct StandardHandleInheritanceGuard(Vec<(HANDLE, u32)>);

impl StandardHandleInheritanceGuard {
    fn exclude(allowed: &[HANDLE]) -> Result<Self, String> {
        let mut guard = Self(Vec::new());
        for standard_id in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
            let handle = unsafe { GetStdHandle(standard_id) };
            if handle.is_null() || handle == INVALID_HANDLE_VALUE || allowed.contains(&handle) {
                continue;
            }
            if guard.0.iter().any(|(known, _)| *known == handle) {
                continue;
            }
            let mut flags = 0;
            if unsafe { GetHandleInformation(handle, &mut flags) } == 0 {
                return Err(win32_error(
                    "Could not inspect helper standard-handle inheritance",
                ));
            }
            guard.0.push((handle, flags));
            if flags & HANDLE_FLAG_INHERIT != 0
                && unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) } == 0
            {
                return Err(win32_error(
                    "Could not prevent helper control-handle inheritance",
                ));
            }
        }
        Ok(guard)
    }
}

impl Drop for StandardHandleInheritanceGuard {
    fn drop(&mut self) {
        for (handle, flags) in &self.0 {
            if flags & HANDLE_FLAG_INHERIT != 0 {
                unsafe { SetHandleInformation(*handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) };
            }
        }
    }
}

struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CloseHandle(self.0) };
        }
    }
}

struct ProcessHandles(PROCESS_INFORMATION);

impl Drop for ProcessHandles {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0.hThread);
            CloseHandle(self.0.hProcess);
        }
    }
}

struct PrivateTempDirectory(PathBuf);

impl PrivateTempDirectory {
    fn remove(self) -> Result<(), String> {
        std::fs::remove_dir_all(&self.0).map_err(|error| {
            format!("Could not remove private AppContainer temp directory: {error}")
        })
    }
}

impl Drop for PrivateTempDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(all(test, not(feature = "sandbox-helper")))]
mod tests {
    use super::{
        build_command_line, build_environment_block, capture_agent_state_dacl,
        capture_workspace_identity, ensure_real_child_directory, quote_windows_argument,
        restore_agent_state_acl, restore_workspace_acl, run_appcontainer_command,
        run_appcontainer_command_with_input, run_appcontainer_command_with_mode, sid_to_string,
        validate_recovery_record, validate_workspace_tree, AppContainerCommand,
        AppContainerProfile, OwnedHandle, RecoveryRecord, SandboxRecovery, WorkspaceAclGrant,
        MAX_CAPTURED_STREAM_BYTES, MAX_ENVIRONMENT_UNITS,
    };
    use std::collections::BTreeMap;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::ptr::null;
    use std::sync::Mutex;
    use std::time::{Duration, Instant};
    use windows_sys::Win32::System::Threading::{CreateEventW, SetEvent};

    static APP_CONTAINER_TEST_LOCK: Mutex<()> = Mutex::new(());

    fn appcontainer_test_lock() -> std::sync::MutexGuard<'static, ()> {
        APP_CONTAINER_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn test_local_app_data(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "xyst-sandbox-{name}-appdata-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).expect("create isolated test LOCALAPPDATA");
        directory
    }

    fn test_workspace_directory(name: &str) -> (PathBuf, PathBuf) {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../.test-tmp");
        std::fs::create_dir_all(&root).expect("create desktop test temp root");
        let fixture_root = root.join(format!(
            "xyst-sandbox-{name}-workspace-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&fixture_root);
        std::fs::create_dir_all(&fixture_root).expect("create isolated sandbox fixture root");
        let workspace = fixture_root.join("workspace");
        std::fs::create_dir_all(&workspace).expect("create isolated sandbox workspace");
        (
            std::fs::canonicalize(workspace).expect("resolve isolated sandbox workspace"),
            fixture_root,
        )
    }

    fn dacl_bytes(path: &Path, directory: bool) -> Vec<u8> {
        use super::{
            CreateFileW, GetSecurityInfo, LocalFree, OwnedHandle, DACL_SECURITY_INFORMATION,
            FILE_FLAG_BACKUP_SEMANTICS, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ,
            FILE_SHARE_WRITE, OPEN_EXISTING, READ_CONTROL, SE_FILE_OBJECT,
        };
        use std::os::windows::ffi::OsStrExt;
        let wide_path = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let handle = unsafe {
            CreateFileW(
                wide_path.as_ptr(),
                READ_CONTROL | FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                std::ptr::null(),
                OPEN_EXISTING,
                if directory {
                    FILE_FLAG_BACKUP_SEMANTICS
                } else {
                    0
                },
                std::ptr::null_mut(),
            )
        };
        assert_ne!(handle, super::INVALID_HANDLE_VALUE);
        let handle = OwnedHandle(handle);
        let mut dacl = std::ptr::null_mut();
        let mut descriptor = std::ptr::null_mut();
        let status = unsafe {
            GetSecurityInfo(
                handle.0,
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut dacl,
                std::ptr::null_mut(),
                &mut descriptor,
            )
        };
        assert_eq!(status, 0);
        let bytes = if dacl.is_null() {
            Vec::new()
        } else {
            unsafe { std::slice::from_raw_parts(dacl.cast::<u8>(), (*dacl).AclSize.into()) }
                .to_vec()
        };
        if !descriptor.is_null() {
            unsafe { LocalFree(descriptor.cast()) };
        }
        bytes
    }

    fn set_dacl_protection(path: &Path, directory: bool, protected: bool) {
        use super::{
            CreateFileW, GetSecurityInfo, LocalFree, OwnedHandle, SetSecurityInfo,
            DACL_SECURITY_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_DELETE,
            FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING, PROTECTED_DACL_SECURITY_INFORMATION,
            READ_CONTROL, SE_FILE_OBJECT, UNPROTECTED_DACL_SECURITY_INFORMATION, WRITE_DAC,
        };
        use std::os::windows::ffi::OsStrExt;
        let wide_path = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let handle = unsafe {
            CreateFileW(
                wide_path.as_ptr(),
                READ_CONTROL | WRITE_DAC,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                std::ptr::null(),
                OPEN_EXISTING,
                if directory {
                    FILE_FLAG_BACKUP_SEMANTICS
                } else {
                    0
                },
                std::ptr::null_mut(),
            )
        };
        assert_ne!(handle, super::INVALID_HANDLE_VALUE);
        let handle = OwnedHandle(handle);
        let mut dacl = std::ptr::null_mut();
        let mut descriptor = std::ptr::null_mut();
        let status = unsafe {
            GetSecurityInfo(
                handle.0,
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut dacl,
                std::ptr::null_mut(),
                &mut descriptor,
            )
        };
        assert_eq!(status, 0);
        let status = unsafe {
            SetSecurityInfo(
                handle.0,
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION
                    | if protected {
                        PROTECTED_DACL_SECURITY_INFORMATION
                    } else {
                        UNPROTECTED_DACL_SECURITY_INFORMATION
                    },
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                dacl,
                std::ptr::null_mut(),
            )
        };
        if !descriptor.is_null() {
            unsafe { LocalFree(descriptor.cast()) };
        }
        assert_eq!(status, 0);
    }

    #[test]
    fn workspace_preflight_rejects_descendants_with_protected_permissions() {
        let _test_lock = appcontainer_test_lock();
        let workspace = std::env::temp_dir().join(format!(
            "xyst-sandbox-protected-dacl-workspace-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&workspace);
        let nested = workspace.join("nested");
        std::fs::create_dir_all(&nested).expect("create nested workspace directory");
        let protected_directory = nested.join("protected-directory");
        std::fs::create_dir(&protected_directory).expect("create protected directory fixture");
        let protected_file = protected_directory.join("existing.txt");
        std::fs::write(&protected_file, "fixture").expect("create protected file fixture");

        set_dacl_protection(&protected_directory, true, true);
        let error = validate_workspace_tree(&workspace)
            .expect_err("protected descendant permissions must fail closed");
        assert!(
            error.contains("protected permissions"),
            "unexpected error: {error}"
        );
        assert!(
            error.contains("protected-directory"),
            "unexpected path: {error}"
        );

        set_dacl_protection(&protected_directory, true, false);
        set_dacl_protection(&protected_file, false, true);
        let error = validate_workspace_tree(&workspace)
            .expect_err("protected file permissions must fail closed");
        assert!(
            error.contains("protected permissions"),
            "unexpected error: {error}"
        );
        assert!(error.contains("existing.txt"), "unexpected path: {error}");
        std::fs::remove_dir_all(workspace).expect("remove protected DACL workspace fixture");
    }

    #[test]
    fn workspace_preflight_rejects_directory_junctions() {
        let workspace_root = std::env::temp_dir().join(format!(
            "xyst-sandbox-junction-workspace-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&workspace_root);
        let workspace = workspace_root.join("workspace");
        let outside = workspace_root.join("outside");
        std::fs::create_dir_all(&workspace).expect("create junction workspace");
        std::fs::create_dir_all(&outside).expect("create junction target");
        std::fs::write(outside.join("host-secret.txt"), "outside the workspace")
            .expect("create outside canary");
        let junction = workspace.join("escape-junction");
        let result = Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&junction)
            .arg(&outside)
            .output()
            .expect("run Windows junction creation command");
        assert!(
            result.status.success(),
            "could not create directory junction: {}{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );

        let error = validate_workspace_tree(&workspace)
            .expect_err("workspace preflight must reject a directory junction");
        assert!(error.contains("reparse point"), "unexpected error: {error}");
        assert!(
            error.contains("escape-junction"),
            "unexpected path: {error}"
        );

        std::fs::remove_dir(&junction).expect("remove junction without traversing its target");
        std::fs::remove_dir_all(workspace_root).expect("remove junction fixtures");
    }

    #[test]
    #[ignore = "requires Windows symbolic-link creation privilege; exercised by the dedicated Windows CI step"]
    fn workspace_preflight_rejects_file_symbolic_links_without_reading_the_target() {
        let workspace_root = std::env::temp_dir().join(format!(
            "xyst-sandbox-file-symlink-workspace-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&workspace_root);
        let workspace = workspace_root.join("workspace");
        let outside = workspace_root.join("outside");
        std::fs::create_dir_all(&workspace).expect("create file-symlink workspace");
        std::fs::create_dir_all(&outside).expect("create file-symlink target directory");
        let outside_file = outside.join("host-secret.txt");
        std::fs::write(&outside_file, "outside the workspace").expect("create outside canary");
        let link = workspace.join("escape-link.txt");
        let result = Command::new("cmd.exe")
            .args(["/d", "/c", "mklink"])
            .arg(&link)
            .arg(&outside_file)
            .output()
            .expect("run Windows file symbolic-link creation command");
        assert!(
            result.status.success(),
            "could not create file symbolic link: {}{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );

        let error = validate_workspace_tree(&workspace)
            .expect_err("workspace preflight must reject a file symbolic link");
        assert!(error.contains("reparse point"), "unexpected error: {error}");
        assert!(
            error.contains("escape-link.txt"),
            "unexpected path: {error}"
        );
        assert_eq!(
            std::fs::read_to_string(&outside_file).expect("read outside canary"),
            "outside the workspace"
        );

        std::fs::remove_file(&link).expect("remove file symbolic link without traversal");
        std::fs::remove_dir_all(workspace_root).expect("remove file-symlink fixtures");
    }

    #[test]
    #[ignore = "requires Windows symbolic-link creation privilege; exercised by the dedicated Windows CI step"]
    fn workspace_preflight_rejects_directory_symbolic_links_without_traversal() {
        let workspace_root = std::env::temp_dir().join(format!(
            "xyst-sandbox-directory-symlink-workspace-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&workspace_root);
        let workspace = workspace_root.join("workspace");
        let outside = workspace_root.join("outside");
        std::fs::create_dir_all(&workspace).expect("create directory-symlink workspace");
        std::fs::create_dir_all(&outside).expect("create directory-symlink target");
        let outside_file = outside.join("host-secret.txt");
        std::fs::write(&outside_file, "outside the workspace").expect("create outside canary");
        let link = workspace.join("escape-link");
        let result = Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/D"])
            .arg(&link)
            .arg(&outside)
            .output()
            .expect("run Windows directory symbolic-link creation command");
        assert!(
            result.status.success(),
            "could not create directory symbolic link: {}{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );

        let error = validate_workspace_tree(&workspace)
            .expect_err("workspace preflight must reject a directory symbolic link");
        assert!(error.contains("reparse point"), "unexpected error: {error}");
        assert!(error.contains("escape-link"), "unexpected path: {error}");
        assert_eq!(
            std::fs::read_to_string(&outside_file).expect("read outside canary"),
            "outside the workspace"
        );

        std::fs::remove_dir(&link).expect("remove directory symbolic link without traversal");
        std::fs::remove_dir_all(workspace_root).expect("remove directory-symlink fixtures");
    }

    #[test]
    fn windows_argv_quoting_preserves_spaces_quotes_and_trailing_backslashes() {
        assert_eq!(quote_windows_argument("plain"), "plain");
        assert_eq!(quote_windows_argument("two words"), "\"two words\"");
        assert_eq!(quote_windows_argument("a\\\"b"), "\"a\\\\\\\"b\"");
        assert_eq!(
            quote_windows_argument("C:\\folder with space\\"),
            "\"C:\\folder with space\\\\\""
        );
    }

    #[test]
    fn environment_block_is_explicit_sorted_and_double_null_terminated() {
        let environment = BTreeMap::from([
            ("WINDIR".to_owned(), "C:\\Windows".to_owned()),
            ("PATH".to_owned(), "C:\\Windows\\System32".to_owned()),
        ]);
        let block = build_environment_block(&environment).unwrap();
        assert_eq!(&block[block.len() - 2..], &[0, 0]);
        assert!(String::from_utf16_lossy(&block).starts_with("PATH=C:\\Windows\\System32\0WINDIR="));
        assert!(
            build_environment_block(&BTreeMap::from([("BAD=KEY".to_owned(), "x".to_owned())]))
                .is_err()
        );
    }

    #[test]
    fn environment_block_rejects_case_insensitive_duplicates_and_nul_values() {
        assert!(build_environment_block(&BTreeMap::from([
            ("Path".to_owned(), "C:\\Windows".to_owned()),
            ("PATH".to_owned(), "C:\\Other".to_owned()),
        ]))
        .is_err());
        assert!(build_environment_block(&BTreeMap::from([(
            "SAFE".to_owned(),
            "value\0injected=entry".to_owned(),
        )]))
        .is_err());
    }

    #[test]
    fn environment_block_enforces_the_windows_size_limit() {
        assert!(build_environment_block(&BTreeMap::from([(
            "LARGE".to_owned(),
            "x".repeat(MAX_ENVIRONMENT_UNITS),
        )]))
        .is_err());
    }

    #[test]
    fn command_line_requires_absolute_executable_and_bounds_windows_length() {
        assert_eq!(
            build_command_line(Path::new("C:\\Windows\\System32\\cmd.exe"), &["/c".into()])
                .unwrap(),
            "C:\\Windows\\System32\\cmd.exe /c"
        );
        assert!(build_command_line(Path::new("cmd.exe"), &[]).is_err());
        assert!(build_command_line(
            Path::new("C:\\Windows\\System32\\cmd.exe"),
            &["x".repeat(32_768)]
        )
        .is_err());
    }

    #[test]
    fn appcontainer_process_runs_inside_a_kill_on_close_job() {
        let _test_guard = appcontainer_test_lock();
        let system_root = std::env::var("SystemRoot").expect("Windows CI must define SystemRoot");
        let command = Path::new(&system_root).join("System32").join("cmd.exe");
        let local_app_data = test_local_app_data("appcontainer-process");
        let environment = BTreeMap::from([
            ("SystemRoot".to_owned(), system_root.clone()),
            ("WINDIR".to_owned(), system_root.clone()),
            ("PATH".to_owned(), format!("{system_root}\\System32")),
            ("ComSpec".to_owned(), command.to_string_lossy().into_owned()),
            (
                "LOCALAPPDATA".to_owned(),
                local_app_data.to_string_lossy().into_owned(),
            ),
        ]);
        let (workspace, fixture_root) = test_workspace_directory("appcontainer-process");
        let existing_file = workspace
            .join("existing")
            .join("nested")
            .join("existing.txt");
        std::fs::create_dir_all(existing_file.parent().unwrap())
            .expect("create existing nested workspace directory");
        std::fs::write(&existing_file, "workspace-readable")
            .expect("create existing workspace file");
        let agent_state = workspace.join(".agent");
        let approval_file = agent_state.join("approvals").join("rules.json");
        std::fs::create_dir_all(approval_file.parent().unwrap())
            .expect("create approval state fixture");
        std::fs::write(&approval_file, "host-approval-canary")
            .expect("write approval state fixture");
        let original_root_acl = dacl_bytes(&workspace, true);
        let original_state_acl = dacl_bytes(&agent_state, true);
        let original_file_acl = dacl_bytes(&existing_file, false);
        let workspace_probe = "echo sandbox-out && echo sandbox-err 1>&2 && (echo workspace-write>new.txt || exit /b 12) && if exist new.txt (exit /b 23) else (exit /b 13)";
        let code = run_appcontainer_command(
            &command,
            &["/d".into(), "/c".into(), workspace_probe.into()],
            &workspace,
            &workspace,
            &environment,
            Duration::from_secs(10),
            None,
        )
        .expect("AppContainer should write to the workspace and preserve bounded standard streams");
        assert_eq!(
            code.exit_code,
            23,
            "sandbox command failed; stdout={:?}; stderr={:?}",
            String::from_utf8_lossy(&code.stdout),
            String::from_utf8_lossy(&code.stderr)
        );
        assert!(!code.timed_out);
        assert!(!code.cancelled);
        assert_eq!(String::from_utf8_lossy(&code.stdout).trim(), "sandbox-out");
        assert_eq!(String::from_utf8_lossy(&code.stderr).trim(), "sandbox-err");
        assert!(!code.stdout_truncated);
        assert!(!code.stderr_truncated);
        assert_eq!(
            std::fs::read_to_string(&existing_file).unwrap(),
            "workspace-readable"
        );
        assert_eq!(
            std::fs::read_to_string(workspace.join("new.txt"))
                .unwrap()
                .trim(),
            "workspace-write"
        );
        let powershell = Path::new(&system_root)
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe");
        let state_probe = "$p = Join-Path $PWD '.agent\\approvals\\rules.json'; try { Get-Content -LiteralPath $p -ErrorAction Stop; exit 31 } catch {}; try { Set-Content -LiteralPath $p -Value 'forged' -ErrorAction Stop; exit 32 } catch {}; Write-Output 'approval-state-protected'";
        let state_outcome = run_appcontainer_command(
            &powershell,
            &[
                "-NoLogo".into(),
                "-NoProfile".into(),
                "-Command".into(),
                state_probe.into(),
            ],
            &workspace,
            &workspace,
            &environment,
            Duration::from_secs(10),
            None,
        )
        .expect("AppContainer should not read or write persisted Xyst approval state");
        assert_eq!(
            state_outcome.exit_code,
            0,
            "stdout={:?}, stderr={:?}",
            String::from_utf8_lossy(&state_outcome.stdout),
            String::from_utf8_lossy(&state_outcome.stderr)
        );
        assert!(String::from_utf8_lossy(&state_outcome.stdout).contains("approval-state-protected"));
        assert_eq!(
            std::fs::read_to_string(&approval_file).unwrap(),
            "host-approval-canary"
        );
        let read_only_args = [
            "/d".into(),
            "/c".into(),
            "echo denied > read-only.txt".into(),
        ];
        let read_only_outcome = run_appcontainer_command_with_mode(AppContainerCommand {
            executable: &command,
            args: &read_only_args,
            workspace_root: &workspace,
            workspace_read_only: true,
            current_directory: &workspace,
            environment: &environment,
            stdin: &[],
            timeout: Duration::from_secs(10),
            cancellation_event: None,
        })
        .expect("read-only AppContainer should launch and return the denied write result");
        assert_ne!(read_only_outcome.exit_code, 0);
        assert!(!workspace.join("read-only.txt").exists());
        let stdin_args = ["/d".into(), "/c".into(), "more".into()];
        let stdin_outcome = run_appcontainer_command_with_input(AppContainerCommand {
            executable: &command,
            args: &stdin_args,
            workspace_root: &workspace,
            workspace_read_only: false,
            current_directory: &workspace,
            environment: &environment,
            stdin: b"stdin-forwarded\r\n",
            timeout: Duration::from_secs(10),
            cancellation_event: None,
        })
        .expect("AppContainer should receive bounded stdin and close it after forwarding");
        assert_eq!(stdin_outcome.exit_code, 0);
        assert_eq!(
            String::from_utf8_lossy(&stdin_outcome.stdout).trim_end(),
            "stdin-forwarded"
        );
        assert_eq!(dacl_bytes(&workspace, true), original_root_acl);
        assert_eq!(dacl_bytes(&agent_state, true), original_state_acl);
        assert_eq!(dacl_bytes(&existing_file, false), original_file_acl);
        std::fs::remove_dir_all(fixture_root).expect("clean sandbox workspace fixture");
        std::fs::remove_dir_all(local_app_data).expect("clean isolated test LOCALAPPDATA");
    }

    #[test]
    fn appcontainer_output_capture_is_bounded_while_pipes_continue_draining() {
        let _test_guard = appcontainer_test_lock();
        let system_root = std::env::var("WINDIR").expect("Windows CI must define WINDIR");
        let command = PathBuf::from(&system_root).join("System32\\cmd.exe");
        let local_app_data = test_local_app_data("appcontainer-output");
        let mut environment = BTreeMap::from([
            ("WINDIR".to_owned(), system_root.clone()),
            ("PATH".to_owned(), format!("{system_root}\\System32")),
            ("ComSpec".to_owned(), command.to_string_lossy().into_owned()),
            (
                "LOCALAPPDATA".to_owned(),
                local_app_data.to_string_lossy().into_owned(),
            ),
        ]);
        environment.insert("XYST_STDOUT_FIXTURE".into(), "x".repeat(3600));
        environment.insert("XYST_STDERR_FIXTURE".into(), "y".repeat(3600));
        let workspace = std::env::temp_dir().join(format!(
            "xyst-sandbox-output-workspace-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&workspace).expect("create output workspace");
        let outcome = run_appcontainer_command(
            &command,
            &[
                "/d".into(),
                "/c".into(),
                "for /L %i in (1,1,320) do @echo %XYST_STDOUT_FIXTURE% & @echo %XYST_STDERR_FIXTURE% 1>&2".into(),
            ],
            &workspace,
            &workspace,
            &environment,
            Duration::from_secs(20),
            None,
        )
        .expect("large stdout and stderr should drain without blocking the process");
        assert_eq!(
            outcome.exit_code,
            0,
            "large-output command failed; stderr prefix: {}",
            String::from_utf8_lossy(&outcome.stderr[..outcome.stderr.len().min(512)])
        );
        assert!(outcome.stdout_truncated);
        assert_eq!(outcome.stdout.len(), MAX_CAPTURED_STREAM_BYTES);
        assert!(outcome.stderr_truncated);
        assert_eq!(outcome.stderr.len(), MAX_CAPTURED_STREAM_BYTES);
        assert!(outcome.stdout.starts_with(b"x"));
        assert!(outcome.stderr.starts_with(b"y"));
        std::fs::remove_dir_all(workspace).expect("remove output workspace");
        std::fs::remove_dir_all(local_app_data).expect("clean isolated test LOCALAPPDATA");
    }

    #[test]
    fn appcontainer_timeout_terminates_the_job_and_reports_elapsed_time() {
        let _test_guard = appcontainer_test_lock();
        let system_root = std::env::var("SystemRoot").expect("Windows CI must define SystemRoot");
        let command = Path::new(&system_root).join("System32").join("cmd.exe");
        let local_app_data = test_local_app_data("appcontainer-timeout");
        let environment = BTreeMap::from([
            ("SystemRoot".to_owned(), system_root.clone()),
            ("WINDIR".to_owned(), system_root.clone()),
            ("PATH".to_owned(), format!("{system_root}\\System32")),
            (
                "LOCALAPPDATA".to_owned(),
                local_app_data.to_string_lossy().into_owned(),
            ),
        ]);
        let workspace = std::env::temp_dir().join(format!(
            "xyst-sandbox-timeout-workspace-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&workspace).expect("create timeout workspace");
        let started = Instant::now();
        let outcome = run_appcontainer_command(
            &command,
            &[
                "/d".into(),
                "/c".into(),
                "for /L %i in (1,1,999999) do @ver >nul".into(),
            ],
            &workspace,
            &workspace,
            &environment,
            Duration::from_millis(100),
            None,
        )
        .expect("AppContainer timeout should terminate the command job");
        assert!(outcome.timed_out);
        assert!(!outcome.cancelled);
        assert!(outcome.elapsed < Duration::from_secs(10));
        assert!(started.elapsed() < Duration::from_secs(10));
        std::fs::remove_dir_all(workspace).expect("remove timeout workspace");
        std::fs::remove_dir_all(local_app_data).expect("clean isolated test LOCALAPPDATA");
    }

    #[test]
    fn pre_signalled_cancellation_stops_before_resuming_the_appcontainer() {
        let _test_guard = appcontainer_test_lock();
        let system_root = std::env::var("SystemRoot").expect("Windows CI must define SystemRoot");
        let command = Path::new(&system_root).join("System32").join("cmd.exe");
        let local_app_data = test_local_app_data("appcontainer-pre-cancel");
        let environment = BTreeMap::from([
            ("SystemRoot".to_owned(), system_root.clone()),
            ("WINDIR".to_owned(), system_root.clone()),
            ("PATH".to_owned(), format!("{system_root}\\System32")),
            (
                "LOCALAPPDATA".to_owned(),
                local_app_data.to_string_lossy().into_owned(),
            ),
        ]);
        let workspace = std::env::temp_dir().join(format!(
            "xyst-sandbox-cancel-workspace-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&workspace).expect("create cancellation workspace");
        let event = unsafe { CreateEventW(null(), 1, 1, null()) };
        assert!(!event.is_null());
        let event = OwnedHandle(event);
        let outcome = run_appcontainer_command(
            &command,
            &["/d".into(), "/c".into(), "exit /b 19".into()],
            &workspace,
            &workspace,
            &environment,
            Duration::from_secs(10),
            Some(event.0),
        )
        .expect("signalled cancellation should stop the suspended process");
        assert!(outcome.cancelled);
        assert!(!outcome.timed_out);
        assert_ne!(outcome.exit_code, 19);
        std::fs::remove_dir_all(workspace).expect("remove cancellation workspace");
        std::fs::remove_dir_all(local_app_data).expect("clean isolated test LOCALAPPDATA");
    }

    #[test]
    fn in_flight_cancellation_terminates_the_appcontainer_job() {
        let _test_guard = appcontainer_test_lock();
        let system_root = std::env::var("SystemRoot").expect("Windows CI must define SystemRoot");
        let command = Path::new(&system_root).join("System32").join("cmd.exe");
        let local_app_data = test_local_app_data("appcontainer-in-flight-cancel");
        let environment = BTreeMap::from([
            ("SystemRoot".to_owned(), system_root.clone()),
            ("WINDIR".to_owned(), system_root.clone()),
            ("PATH".to_owned(), format!("{system_root}\\System32")),
            (
                "LOCALAPPDATA".to_owned(),
                local_app_data.to_string_lossy().into_owned(),
            ),
        ]);
        let workspace = std::env::temp_dir().join(format!(
            "xyst-sandbox-cancel-running-workspace-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&workspace).expect("create in-flight cancellation workspace");
        let event = unsafe { CreateEventW(null(), 1, 0, null()) };
        assert!(!event.is_null());
        let event = OwnedHandle(event);
        let event_value = event.0 as usize;
        let signaler = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            assert_ne!(unsafe { SetEvent(event_value as _) }, 0);
        });
        let outcome = run_appcontainer_command(
            &command,
            &[
                "/d".into(),
                "/c".into(),
                "for /L %i in (1,1,999999) do @ver >nul".into(),
            ],
            &workspace,
            &workspace,
            &environment,
            Duration::from_secs(10),
            Some(event.0),
        )
        .expect("in-flight cancellation should terminate the process job");
        signaler.join().expect("signal cancellation event");
        assert!(outcome.cancelled);
        assert!(!outcome.timed_out);
        assert!(outcome.elapsed < Duration::from_secs(5));
        std::fs::remove_dir_all(workspace).expect("remove in-flight cancellation workspace");
        std::fs::remove_dir_all(local_app_data).expect("clean isolated test LOCALAPPDATA");
    }

    #[test]
    fn recovery_journal_restores_workspace_permissions_after_interrupted_run() {
        let workspace = std::env::temp_dir().join(format!(
            "xyst-sandbox-recovery-workspace-{}",
            std::process::id()
        ));
        let local_app_data = test_local_app_data("recovery-interrupted");
        std::fs::create_dir_all(&workspace).expect("create recovery workspace");
        std::fs::write(workspace.join("existing.txt"), "before crash")
            .expect("create recovery workspace file");
        let agent_state = ensure_real_child_directory(&workspace, ".agent")
            .expect("create protected state fixture");
        let agent_state_dacl = capture_agent_state_dacl(&agent_state)
            .expect("capture original protected state permissions");
        let original_root_acl = dacl_bytes(&workspace, true);
        let original_file_acl = dacl_bytes(&workspace.join("existing.txt"), false);
        let recovery = SandboxRecovery::open(&local_app_data).expect("open recovery manager");
        assert!(
            SandboxRecovery::open(&local_app_data).is_err(),
            "a second host must not enter recovery while the first owns the lock"
        );
        let identity = capture_workspace_identity(&workspace).expect("capture workspace identity");
        let profile_identity = format!("{}{:032x}", super::PROFILE_PREFIX, std::process::id());
        let mut profile =
            AppContainerProfile::create(&profile_identity).expect("create test profile");
        let journal = recovery
            .write(RecoveryRecord {
                version: 3,
                profile_identity,
                sid: sid_to_string(profile.sid).expect("format AppContainer SID"),
                workspace_path: std::fs::canonicalize(&workspace)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                workspace_identity: identity,
                agent_state_dacl: Some(agent_state_dacl.clone()),
                agent_state_identity: Some(capture_workspace_identity(&agent_state).unwrap()),
            })
            .expect("write recovery intent before ACL modification");
        let grant = WorkspaceAclGrant::apply(
            &workspace,
            profile.sid,
            identity,
            false,
            agent_state_dacl.clone(),
        )
        .expect("grant workspace permissions");
        std::mem::forget(grant);
        assert_ne!(dacl_bytes(&workspace, true), original_root_acl);

        recovery.recover().expect("recover interrupted ACL grant");
        assert_eq!(dacl_bytes(&workspace, true), original_root_acl);
        assert_eq!(dacl_bytes(&agent_state, true), agent_state_dacl);
        assert_eq!(
            dacl_bytes(&workspace.join("existing.txt"), false),
            original_file_acl
        );
        assert!(!journal.exists());
        profile.remove().expect("release test profile SID");
        drop(recovery);
        std::fs::remove_dir_all(workspace).expect("remove recovery workspace");
        std::fs::remove_dir_all(local_app_data).expect("remove recovery app data");
    }

    #[test]
    fn recovery_refuses_local_app_data_directory_junctions_before_creating_state() {
        let fixture_root = std::env::temp_dir().join(format!(
            "xyst-sandbox-recovery-localappdata-junction-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&fixture_root);
        let target = fixture_root.join("real-local-app-data");
        let junction = fixture_root.join("redirected-local-app-data");
        std::fs::create_dir_all(&target).expect("create LOCALAPPDATA junction target");
        std::fs::create_dir_all(&fixture_root).expect("create junction fixture root");
        let result = Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&junction)
            .arg(&target)
            .output()
            .expect("run Windows junction creation command");
        assert!(
            result.status.success(),
            "could not create LOCALAPPDATA junction: {}{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );

        let recovery_result = SandboxRecovery::open(&junction);
        let error = match recovery_result {
            Ok(recovery) => {
                drop(recovery);
                None
            }
            Err(error) => Some(error),
        };
        let target_state_was_created = target.join("Xyst AI Assistant").exists();

        std::fs::remove_dir(&junction).expect("remove LOCALAPPDATA junction without traversal");
        std::fs::remove_dir_all(&fixture_root).expect("remove junction fixture tree");

        let error = error.expect("recovery must reject a junction used as LOCALAPPDATA");
        assert!(
            error.contains("real director") || error.contains("reparse point"),
            "unexpected error: {error}"
        );
        assert!(
            !target_state_was_created,
            "refusing a junction must not create recovery state in its target"
        );
    }

    #[test]
    fn recovery_refuses_parent_junctions_in_local_app_data_path() {
        let fixture_root = std::env::temp_dir().join(format!(
            "xyst-sandbox-recovery-localappdata-parent-junction-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&fixture_root);
        let target_parent = fixture_root.join("real-parent");
        let junction_parent = fixture_root.join("redirected-parent");
        let target = target_parent.join("LocalData");
        let requested_path = junction_parent.join("LocalData");
        std::fs::create_dir_all(&target).expect("create LOCALAPPDATA target");
        let result = Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&junction_parent)
            .arg(&target_parent)
            .output()
            .expect("run Windows parent-junction creation command");
        assert!(
            result.status.success(),
            "could not create LOCALAPPDATA parent junction: {}{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );

        let recovery_result = SandboxRecovery::open(&requested_path);
        let error = match recovery_result {
            Ok(recovery) => {
                drop(recovery);
                None
            }
            Err(error) => Some(error),
        };
        let target_state_was_created = target.join("Xyst AI Assistant").exists();

        std::fs::remove_dir(&junction_parent)
            .expect("remove parent junction without traversing its target");
        std::fs::remove_dir_all(&fixture_root).expect("remove parent junction fixture tree");

        let error = error.expect("recovery must reject a reparse point in the path ancestry");
        assert!(
            error.contains("real director") || error.contains("reparse point"),
            "unexpected error: {error}"
        );
        assert!(
            !target_state_was_created,
            "refusing a parent junction must not create recovery state in its target"
        );
    }

    #[test]
    fn recovery_completes_cleanup_after_interruption_following_acl_restoration() {
        let workspace = std::env::temp_dir().join(format!(
            "xyst-sandbox-recovery-restored-workspace-{}",
            std::process::id()
        ));
        let local_app_data = test_local_app_data("recovery-restored");
        std::fs::create_dir_all(&workspace).expect("create recovery workspace");
        std::fs::write(workspace.join("existing.txt"), "recovery fixture")
            .expect("create recovery workspace file");
        let agent_state = ensure_real_child_directory(&workspace, ".agent")
            .expect("create protected state fixture");
        let agent_state_dacl = capture_agent_state_dacl(&agent_state)
            .expect("capture original protected state permissions");
        let original_root_acl = dacl_bytes(&workspace, true);
        let original_file_acl = dacl_bytes(&workspace.join("existing.txt"), false);
        let recovery = SandboxRecovery::open(&local_app_data).expect("open recovery manager");
        let identity = capture_workspace_identity(&workspace).expect("capture workspace identity");
        let profile_identity = format!(
            "{}{:032x}",
            super::PROFILE_PREFIX,
            std::process::id().wrapping_add(2)
        );
        let mut profile =
            AppContainerProfile::create(&profile_identity).expect("create test profile");
        let journal = recovery
            .write(RecoveryRecord {
                version: 3,
                profile_identity,
                sid: sid_to_string(profile.sid).expect("format test profile SID"),
                workspace_path: std::fs::canonicalize(&workspace)
                    .expect("canonicalize recovery workspace")
                    .to_string_lossy()
                    .into_owned(),
                workspace_identity: identity,
                agent_state_dacl: Some(agent_state_dacl.clone()),
                agent_state_identity: Some(capture_workspace_identity(&agent_state).unwrap()),
            })
            .expect("write recovery intent before ACL modification");
        let grant = WorkspaceAclGrant::apply(
            &workspace,
            profile.sid,
            identity,
            false,
            agent_state_dacl.clone(),
        )
        .expect("grant workspace permissions");
        std::mem::forget(grant);

        restore_workspace_acl(
            &workspace,
            profile.sid,
            identity,
            Some(&agent_state_dacl),
            Some(capture_workspace_identity(&agent_state).unwrap()),
        )
        .expect("restore ACL before simulating interrupted cleanup");
        assert_eq!(dacl_bytes(&workspace, true), original_root_acl);
        assert_eq!(dacl_bytes(&agent_state, true), agent_state_dacl);
        assert_eq!(
            dacl_bytes(&workspace.join("existing.txt"), false),
            original_file_acl
        );
        assert!(
            journal.exists(),
            "journal remains until all recovery cleanup finishes"
        );

        recovery
            .recover()
            .expect("retry recovery after ACL restoration completed");
        recovery
            .recover()
            .expect("a completed recovery remains safe to retry");
        assert_eq!(dacl_bytes(&workspace, true), original_root_acl);
        assert_eq!(
            dacl_bytes(&workspace.join("existing.txt"), false),
            original_file_acl
        );
        assert!(!journal.exists(), "completed recovery removes its journal");
        profile
            .remove()
            .expect("release test profile SID after recovery");
        drop(recovery);
        std::fs::remove_dir_all(workspace).expect("remove recovery workspace");
        std::fs::remove_dir_all(local_app_data).expect("remove recovery app data");
    }

    #[test]
    fn recovery_removes_journal_after_profile_was_deleted_before_interruption() {
        let workspace = std::env::temp_dir().join(format!(
            "xyst-sandbox-recovery-profile-deleted-workspace-{}",
            std::process::id()
        ));
        let local_app_data = test_local_app_data("recovery-profile-deleted");
        std::fs::create_dir_all(&workspace).expect("create recovery workspace");
        std::fs::write(workspace.join("existing.txt"), "profile deletion fixture")
            .expect("create recovery workspace file");
        let agent_state = ensure_real_child_directory(&workspace, ".agent")
            .expect("create protected state fixture");
        let agent_state_dacl = capture_agent_state_dacl(&agent_state)
            .expect("capture original protected state permissions");
        let original_root_acl = dacl_bytes(&workspace, true);
        let original_file_acl = dacl_bytes(&workspace.join("existing.txt"), false);
        let recovery = SandboxRecovery::open(&local_app_data).expect("open recovery manager");
        let identity = capture_workspace_identity(&workspace).expect("capture workspace identity");
        let profile_identity = format!(
            "{}{:032x}",
            super::PROFILE_PREFIX,
            std::process::id().wrapping_add(3)
        );
        let mut profile =
            AppContainerProfile::create(&profile_identity).expect("create test profile");
        let journal = recovery
            .write(RecoveryRecord {
                version: 3,
                profile_identity,
                sid: sid_to_string(profile.sid).expect("format test profile SID"),
                workspace_path: std::fs::canonicalize(&workspace)
                    .expect("canonicalize recovery workspace")
                    .to_string_lossy()
                    .into_owned(),
                workspace_identity: identity,
                agent_state_dacl: Some(agent_state_dacl.clone()),
                agent_state_identity: Some(capture_workspace_identity(&agent_state).unwrap()),
            })
            .expect("write recovery intent before ACL modification");
        let grant = WorkspaceAclGrant::apply(
            &workspace,
            profile.sid,
            identity,
            false,
            agent_state_dacl.clone(),
        )
        .expect("grant workspace permissions");
        std::mem::forget(grant);
        restore_workspace_acl(
            &workspace,
            profile.sid,
            identity,
            Some(&agent_state_dacl),
            Some(capture_workspace_identity(&agent_state).unwrap()),
        )
        .expect("restore ACL before profile cleanup");
        assert_eq!(dacl_bytes(&workspace, true), original_root_acl);
        assert_eq!(dacl_bytes(&agent_state, true), agent_state_dacl);
        assert_eq!(
            dacl_bytes(&workspace.join("existing.txt"), false),
            original_file_acl
        );

        profile
            .remove()
            .expect("delete profile before simulating interrupted cleanup");
        assert!(journal.exists(), "journal remains after profile deletion");
        recovery
            .recover()
            .expect("recovery should finish cleanup for an already-deleted profile");

        assert_eq!(dacl_bytes(&workspace, true), original_root_acl);
        assert_eq!(
            dacl_bytes(&workspace.join("existing.txt"), false),
            original_file_acl
        );
        assert!(!journal.exists(), "recovery removes the completed journal");
        drop(recovery);
        std::fs::remove_dir_all(workspace).expect("remove recovery workspace");
        std::fs::remove_dir_all(local_app_data).expect("remove recovery app data");
    }

    #[test]
    fn recovery_restores_workspace_permissions_after_host_process_is_force_killed() {
        let suffix = std::process::id().to_string();
        let workspace =
            std::env::temp_dir().join(format!("xyst-sandbox-killed-workspace-{suffix}"));
        let local_app_data = test_local_app_data("recovery-killed");
        let marker = std::env::temp_dir().join(format!("xyst-sandbox-killed-marker-{suffix}"));
        let _ = std::fs::remove_dir_all(&workspace);
        let _ = std::fs::remove_file(&marker);
        std::fs::create_dir_all(&workspace).expect("create interrupted workspace");
        std::fs::write(workspace.join("existing.txt"), "before process termination")
            .expect("create interrupted workspace file");
        let agent_state = ensure_real_child_directory(&workspace, ".agent")
            .expect("create protected state before interrupted grant");
        let original_agent_state_dacl = capture_agent_state_dacl(&agent_state)
            .expect("capture original protected state permissions");
        let original_root_acl = dacl_bytes(&workspace, true);
        let original_file_acl = dacl_bytes(&workspace.join("existing.txt"), false);

        let executable = std::env::current_exe().expect("resolve native test executable");
        let mut child = Command::new(executable)
            .args([
                "--exact",
                "windows_sandbox::tests::recovery_crash_child_grants_workspace_then_waits",
                "--nocapture",
            ])
            .env("XYST_SANDBOX_CRASH_WORKSPACE", &workspace)
            .env("XYST_SANDBOX_CRASH_APPDATA", &local_app_data)
            .env("XYST_SANDBOX_CRASH_MARKER", &marker)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("start isolated recovery child");

        let deadline = Instant::now() + Duration::from_secs(15);
        let mut granted = false;
        while Instant::now() < deadline {
            if marker.exists() {
                granted = true;
                break;
            }
            if let Some(status) = child.try_wait().expect("poll recovery child") {
                panic!("recovery child exited before granting workspace access: {status}");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        if !granted {
            let _ = child.kill();
            let _ = child.wait();
            panic!("recovery child did not reach the ACL-granted crash point");
        }
        child.kill().expect("force-terminate recovery child");
        child.wait().expect("reap force-terminated recovery child");

        let recovery = SandboxRecovery::open(&local_app_data)
            .expect("reopen recovery manager after host death");
        recovery
            .recover()
            .expect("restore ACL after host process termination");
        assert_eq!(dacl_bytes(&workspace, true), original_root_acl);
        assert_eq!(dacl_bytes(&agent_state, true), original_agent_state_dacl);
        assert_eq!(
            dacl_bytes(&workspace.join("existing.txt"), false),
            original_file_acl
        );
        assert_eq!(
            std::fs::read_dir(&recovery.directory).unwrap().count(),
            1,
            "only the recovery lock should remain"
        );
        drop(recovery);
        std::fs::remove_file(marker).expect("remove crash marker");
        std::fs::remove_dir_all(workspace).expect("remove interrupted workspace");
        std::fs::remove_dir_all(local_app_data).expect("remove interrupted recovery state");
    }

    #[test]
    fn recovery_crash_child_grants_workspace_then_waits() {
        let (Ok(workspace), Ok(local_app_data), Ok(marker)) = (
            std::env::var("XYST_SANDBOX_CRASH_WORKSPACE"),
            std::env::var("XYST_SANDBOX_CRASH_APPDATA"),
            std::env::var("XYST_SANDBOX_CRASH_MARKER"),
        ) else {
            return;
        };
        let workspace = PathBuf::from(workspace);
        let agent_state = ensure_real_child_directory(&workspace, ".agent")
            .expect("create protected state directory before grant");
        let agent_state_dacl = capture_agent_state_dacl(&agent_state)
            .expect("capture original protected state permissions");
        let recovery =
            SandboxRecovery::open(Path::new(&local_app_data)).expect("open child recovery manager");
        recovery.recover().expect("start with clean recovery state");
        let identity =
            capture_workspace_identity(&workspace).expect("capture child workspace identity");
        let profile_identity = format!("{}{:032x}", super::PROFILE_PREFIX, std::process::id());
        let profile = AppContainerProfile::create(&profile_identity).expect("create child profile");
        recovery
            .write(RecoveryRecord {
                version: 3,
                profile_identity,
                sid: sid_to_string(profile.sid).expect("format child profile SID"),
                workspace_path: std::fs::canonicalize(&workspace)
                    .expect("canonicalize child workspace")
                    .to_string_lossy()
                    .into_owned(),
                workspace_identity: identity,
                agent_state_dacl: Some(agent_state_dacl.clone()),
                agent_state_identity: Some(capture_workspace_identity(&agent_state).unwrap()),
            })
            .expect("persist recovery intent before granting ACL");
        let grant =
            WorkspaceAclGrant::apply(&workspace, profile.sid, identity, false, agent_state_dacl)
                .expect("grant child workspace ACL");
        std::mem::forget(grant);
        drop(profile);
        std::fs::write(marker, b"acl-granted").expect("signal ACL grant to parent");
        loop {
            std::thread::sleep(Duration::from_secs(60));
        }
    }

    #[test]
    fn recovery_acl_restore_checks_directory_identity_on_the_handle_it_updates() {
        let root = test_local_app_data("recovery-state-identity");
        let state =
            ensure_real_child_directory(&root, ".agent").expect("create state directory fixture");
        let original_dacl = capture_agent_state_dacl(&state).expect("capture state ACL");
        let original_acl = dacl_bytes(&state, true);
        let mut wrong_identity = capture_workspace_identity(&state).expect("capture identity");
        wrong_identity.file_index = wrong_identity.file_index.wrapping_add(1);

        let error = restore_agent_state_acl(&state, &original_dacl, Some(wrong_identity))
            .expect_err("replacement identity must be rejected");
        assert!(
            error.contains("identity changed"),
            "unexpected error: {error}"
        );
        assert_eq!(dacl_bytes(&state, true), original_acl);
        restore_agent_state_acl(&root.join("missing-agent-state"), &original_dacl, None)
            .expect("absent state directory needs no ACL restoration");
        std::fs::remove_dir_all(root).expect("remove state identity fixture");
    }

    #[test]
    fn recovery_record_validation_rejects_unsupported_or_unscoped_records() {
        let record = RecoveryRecord {
            version: 1,
            profile_identity: format!("{}{}", super::PROFILE_PREFIX, "a".repeat(32)),
            sid: "S-1-15-2-1".to_owned(),
            workspace_path: r"C:\workspace".to_owned(),
            workspace_identity: super::WorkspaceIdentity {
                volume_serial: 1,
                file_index: 2,
            },
            agent_state_dacl: None,
            agent_state_identity: None,
        };
        assert!(validate_recovery_record(&record).is_ok());
        let mut invalid = record;
        invalid.version = 2;
        assert!(validate_recovery_record(&invalid).is_err());
        invalid.agent_state_dacl = Some(vec![2, 0, 8, 0, 0, 0, 0, 0]);
        assert!(validate_recovery_record(&invalid).is_ok());
        invalid.agent_state_dacl = Some(vec![2, 0, 9, 0, 0, 0, 0, 0]);
        assert!(validate_recovery_record(&invalid).is_err());
    }

    #[test]
    fn recovery_stops_on_a_malformed_record_and_preserves_it_for_diagnosis() {
        let local_app_data = test_local_app_data("recovery-malformed");
        let recovery = SandboxRecovery::open(&local_app_data).expect("open recovery manager");
        let journal = recovery.directory.join("malformed.json");
        std::fs::write(&journal, b"{not-json").expect("write malformed journal");

        let error = recovery
            .recover()
            .expect_err("malformed recovery state must stop sandbox launch");
        assert!(error.contains("invalid"), "unexpected error: {error}");
        assert!(
            journal.exists(),
            "malformed recovery state must be retained"
        );
        drop(recovery);
        std::fs::remove_dir_all(local_app_data).expect("remove malformed recovery app data");
    }

    #[test]
    fn recovery_removes_only_generated_interrupted_temporary_records() {
        let local_app_data = test_local_app_data("recovery-temporary");
        let recovery = SandboxRecovery::open(&local_app_data).expect("open recovery manager");
        let interrupted = recovery
            .directory
            .join(".0123456789abcdef0123456789abcdef.tmp");
        let unrelated = recovery.directory.join("notes.tmp");
        let invalid_name = recovery
            .directory
            .join(".0123456789abcdef0123456789abcdeg.tmp");
        std::fs::write(&interrupted, b"partial recovery record")
            .expect("write interrupted temporary record");
        std::fs::write(&unrelated, b"unrelated temporary data")
            .expect("write unrelated temporary file");
        std::fs::write(&invalid_name, b"unrecognized temporary data")
            .expect("write invalid-name temporary file");

        recovery
            .recover()
            .expect("discard incomplete record before any ACL grant was committed");

        assert!(
            !interrupted.exists(),
            "a valid orphaned recovery temp file should be removed"
        );
        assert_eq!(
            std::fs::read(&unrelated).expect("read unrelated temp file"),
            b"unrelated temporary data"
        );
        assert_eq!(
            std::fs::read(&invalid_name).expect("read invalid-name temp file"),
            b"unrecognized temporary data"
        );
        drop(recovery);
        std::fs::remove_dir_all(local_app_data).expect("remove temporary recovery app data");
    }

    #[test]
    fn recovery_write_preserves_collisions_and_cleans_up_after_commit_failure() {
        let local_app_data = test_local_app_data("recovery-write-failures");
        let recovery = SandboxRecovery::open(&local_app_data).expect("open recovery manager");
        let make_record = || RecoveryRecord {
            version: 1,
            profile_identity: format!("{}{}", super::PROFILE_PREFIX, "a".repeat(32)),
            sid: "S-1-15-2-1".to_owned(),
            workspace_path: r"C:\workspace".to_owned(),
            workspace_identity: super::WorkspaceIdentity {
                volume_serial: 1,
                file_index: 2,
            },
            agent_state_dacl: None,
            agent_state_identity: None,
        };

        let collision_id = "0123456789abcdef0123456789abcdef";
        let existing_temporary = recovery.directory.join(format!(".{collision_id}.tmp"));
        std::fs::write(&existing_temporary, b"pre-existing temporary file")
            .expect("create temp-name collision");
        let error = recovery
            .write_with_id(make_record(), collision_id)
            .expect_err("an existing temporary path must prevent journal creation");
        assert!(
            error.contains("Could not create sandbox recovery record"),
            "unexpected collision error: {error}"
        );
        assert_eq!(
            std::fs::read(&existing_temporary).expect("read preserved collision"),
            b"pre-existing temporary file"
        );

        let commit_id = "fedcba9876543210fedcba9876543210";
        let existing_journal = recovery.directory.join(format!("{commit_id}.json"));
        let interrupted_temporary = recovery.directory.join(format!(".{commit_id}.tmp"));
        std::fs::write(&existing_journal, b"existing journal must remain")
            .expect("create destination collision");
        let error = recovery
            .write_with_id(make_record(), commit_id)
            .expect_err("journal commit must not replace an existing destination");
        assert!(
            error.contains("Could not commit sandbox recovery record"),
            "unexpected commit error: {error}"
        );
        assert!(
            !interrupted_temporary.exists(),
            "a temp file created by the failed write should be removed"
        );
        assert_eq!(
            std::fs::read(&existing_journal).expect("read preserved journal"),
            b"existing journal must remain"
        );
        drop(recovery);
        std::fs::remove_dir_all(local_app_data).expect("remove recovery write test data");
    }

    #[test]
    fn recovery_refuses_a_workspace_identity_mismatch_and_keeps_the_journal() {
        let workspace = std::env::temp_dir().join(format!(
            "xyst-sandbox-recovery-mismatch-workspace-{}",
            std::process::id()
        ));
        let local_app_data = test_local_app_data("recovery-mismatch");
        std::fs::create_dir_all(&workspace).expect("create recovery mismatch workspace");
        let original_root_acl = dacl_bytes(&workspace, true);
        let recovery = SandboxRecovery::open(&local_app_data).expect("open recovery manager");
        let profile_identity = format!(
            "{}{:032x}",
            super::PROFILE_PREFIX,
            std::process::id().wrapping_add(1)
        );
        let mut profile =
            AppContainerProfile::create(&profile_identity).expect("create test profile");
        let mut identity =
            capture_workspace_identity(&workspace).expect("capture workspace identity");
        identity.file_index = identity.file_index.wrapping_add(1);
        let journal = recovery
            .write(RecoveryRecord {
                version: 1,
                profile_identity,
                sid: sid_to_string(profile.sid).expect("format AppContainer SID"),
                workspace_path: std::fs::canonicalize(&workspace)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                workspace_identity: identity,
                agent_state_dacl: None,
                agent_state_identity: None,
            })
            .expect("write mismatched recovery record");

        let error = recovery
            .recover()
            .expect_err("recovery must refuse a replaced workspace");
        assert!(
            error.contains("identity changed"),
            "unexpected error: {error}"
        );
        assert!(journal.exists(), "failed recovery must preserve its record");
        assert_eq!(dacl_bytes(&workspace, true), original_root_acl);
        profile.remove().expect("remove test profile");
        drop(recovery);
        std::fs::remove_file(journal).expect("remove test recovery record");
        std::fs::remove_dir_all(workspace).expect("remove recovery mismatch workspace");
        std::fs::remove_dir_all(local_app_data).expect("remove recovery mismatch app data");
    }

    #[test]
    fn appcontainer_timeout_rejects_zero_submillisecond_and_unbounded_values() {
        let command = Path::new(r"C:\Windows\System32\cmd.exe");
        let workspace = Path::new(r"C:\workspace");
        for timeout in [
            Duration::ZERO,
            Duration::from_nanos(999_999),
            Duration::from_millis(u64::from(u32::MAX)),
        ] {
            let error = run_appcontainer_command(
                command,
                &[],
                workspace,
                workspace,
                &BTreeMap::new(),
                timeout,
                None,
            )
            .expect_err("invalid timeout must be rejected before filesystem access");
            assert!(error.contains("timeout"), "unexpected error: {error}");
        }
    }

    #[test]
    fn workspace_preflight_rejects_external_hard_links() {
        use super::validate_workspace_link_count;

        assert!(validate_workspace_link_count(Path::new("workspace-file.txt"), 1).is_ok());
        let error = validate_workspace_link_count(Path::new("workspace-file.txt"), 2)
            .expect_err("workspace hard link must be rejected");
        assert!(
            error.contains("hard-linked file"),
            "unexpected error: {error}"
        );
    }
}
