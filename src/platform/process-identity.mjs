import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveWindowsPowerShellPath, runProcess, safeProcessEnvironment } from './process.mjs';

/** Capture a non-secret OS identity tuple. Never stores the raw command line. */
export async function captureProcessIdentity(
  pid,
  { platform = process.platform, procRoot = '/proc', windowsSystemRoot = process.env.SystemRoot || process.env.WINDIR } = {},
) {
  if (!Number.isInteger(pid) || pid < 1) return null;
  if (platform === 'linux') {
    try {
      const [statBefore, commandLine, bootId] = await Promise.all([
        fs.readFile(path.join(procRoot, String(pid), 'stat'), 'utf8'),
        fs.readFile(path.join(procRoot, String(pid), 'cmdline')),
        fs.readFile(path.join(procRoot, 'sys', 'kernel', 'random', 'boot_id'), 'utf8'),
      ]);
      const before = parseLinuxProcessStat(statBefore);
      const statAfter = await fs.readFile(path.join(procRoot, String(pid), 'stat'), 'utf8');
      const after = parseLinuxProcessStat(statAfter);
      if (before.startTicks !== after.startTicks) return null;
      return {
        platform,
        pid,
        boot_id: bootId.trim(),
        start_ticks: after.startTicks,
        process_group_id: after.processGroupId,
        process_state: after.state,
        command_hash: hash(commandLine),
      };
    } catch {
      return null;
    }
  }
  if (platform === 'win32') {
    const processInfo = await readWindowsProcess(pid, windowsSystemRoot);
    return processInfo
      ? {
          platform,
          pid,
          creation_time: processInfo.creation_time,
          image_hash: hash(Buffer.from(processInfo.image_path.toLowerCase(), 'utf8')),
        }
      : null;
  }
  return null;
}

/** Verify PID identity. `mismatch` means a PID exists but no longer names the saved process. */
export async function verifyProcessIdentity(identity, options = {}) {
  if (!identity || !Number.isInteger(identity.pid) || identity.pid < 1) return 'unavailable';
  const platform = options.platform || process.platform;
  if (identity.platform !== platform) return 'mismatch';
  if (platform === 'linux') {
    const current = await captureProcessIdentity(identity.pid, { platform, procRoot: options.procRoot || '/proc' });
    if (!current) {
      const exists = await linuxProcessExists(identity.pid, options.procRoot || '/proc');
      if (exists !== false) return 'unavailable';
      if (process.platform !== 'linux') return 'absent';
      return verifyLinuxProcessGroupAfterLeaderExit(identity);
    }
    const sameProcess = current.boot_id === identity.boot_id && current.start_ticks === identity.start_ticks;
    const expectedGroup = identity.process_group_id ?? identity.pid;
    const sameGroup = current.process_group_id === expectedGroup;
    const commandMatches = current.command_hash === identity.command_hash;
    const exitedLeader = current.process_state === 'Z' && current.command_hash === hash(Buffer.alloc(0));
    return sameProcess && sameGroup && (commandMatches || exitedLeader) ? 'match' : 'mismatch';
  }
  if (platform === 'win32') {
    let current;
    try {
      current = await readWindowsProcess(identity.pid, options.windowsSystemRoot || process.env.SystemRoot || process.env.WINDIR);
    } catch {
      return 'unavailable';
    }
    if (!current) return 'absent';
    return current.creation_time === identity.creation_time &&
      hash(Buffer.from(current.image_path.toLowerCase(), 'utf8')) === identity.image_hash
      ? 'match'
      : 'mismatch';
  }
  return 'unavailable';
}

/** Stop a recovered Windows process tree only after verifying the root and pinning descendants in a Job Object. */
export async function terminateVerifiedWindowsProcess(identity, { windowsSystemRoot = process.env.SystemRoot || process.env.WINDIR } = {}) {
  if (
    identity?.platform !== 'win32' ||
    !Number.isInteger(identity.pid) ||
    !/^\d+$/.test(identity.creation_time || '') ||
    !/^[0-9a-f]{64}$/i.test(identity.image_hash || '')
  )
    return 'unavailable';
  const executable = resolveWindowsPowerShellPath({ SystemRoot: windowsSystemRoot });
  if (!executable) return 'unavailable';
  const script = `$ErrorActionPreference='Stop'; $source=@'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
public static class XystVerifiedStopper {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr handle, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr handle, uint flags, StringBuilder name, ref uint size);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint GetLastError();
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int informationClass, out ProcessBasicInformation information, int size, out int returned);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct ProcessEntry {
    public uint size, usage, processId; public IntPtr heap; public uint moduleId, threads, parentProcessId; public int priority; public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string exeFile;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessBasicInformation {
    public int exitStatus; public IntPtr peb; public IntPtr affinity; public int basePriority; public UIntPtr processId, parentProcessId;
  }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimitInformation {
    public long perProcessUserTime, perJobUserTime; public uint flags; public UIntPtr minimumWorkingSet, maximumWorkingSet;
    public uint activeProcessLimit; public UIntPtr affinity; public uint priorityClass, schedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong readOperations, writeOperations, otherOperations, readBytes, writeBytes, otherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimitInformation {
    public BasicLimitInformation basic; public IoCounters io; public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
  }
  sealed class PinnedProcess {
    public IntPtr handle; public long creation;
    public PinnedProcess(IntPtr value, long created) { handle=value; creation=created; }
  }
  const uint PROCESS_TERMINATE=0x0001, PROCESS_SET_QUOTA=0x0100, PROCESS_QUERY_LIMITED_INFORMATION=0x1000;
  const uint SNAP_PROCESS=0x00000002, JOB_KILL_ON_CLOSE=0x00002000;
  const int JOB_EXTENDED_LIMIT_INFORMATION=9;
  const long FILETIME_EPOCH=504911232000000000L;
  static bool ReadParent(IntPtr handle, out uint parent) {
    ProcessBasicInformation info; int returned;
    if(NtQueryInformationProcess(handle,0,out info,Marshal.SizeOf(typeof(ProcessBasicInformation)),out returned)!=0) { parent=0; return false; }
    parent=unchecked((uint)info.parentProcessId.ToUInt64()); return true;
  }
  static Dictionary<uint,uint> SnapshotParents() {
    var result=new Dictionary<uint,uint>(); IntPtr snapshot=CreateToolhelp32Snapshot(SNAP_PROCESS,0);
    if(snapshot==new IntPtr(-1)) throw new InvalidOperationException("process snapshot failed");
    try {
      var entry=new ProcessEntry(); entry.size=(uint)Marshal.SizeOf(typeof(ProcessEntry));
      if(!Process32FirstW(snapshot,ref entry)) throw new InvalidOperationException("process snapshot enumeration failed");
      do { result[entry.processId]=entry.parentProcessId; } while(Process32NextW(snapshot,ref entry));
      if(GetLastError()!=18) throw new InvalidOperationException("process snapshot enumeration was incomplete");
      return result;
    } finally { CloseHandle(snapshot); }
  }
  static bool PinDescendants(uint root, IntPtr job, Dictionary<uint,PinnedProcess> pinned) {
    // Repeat snapshots until the tree is stable; assigned parents pass future CreateProcess children into the job.
    int stable=0;
    for(int pass=0;pass<64 && stable<2;pass++) {
      Dictionary<uint,uint> parents=SnapshotParents(); var candidates=new List<uint>(); var reachable=new HashSet<uint>{root};
      bool changed=true;
      while(changed) {
        changed=false;
        foreach(var pair in parents) if(reachable.Contains(pair.Value) && reachable.Add(pair.Key)) { changed=true; if(pair.Key!=root) candidates.Add(pair.Key); }
      }
      bool added=false;
      foreach(uint pid in candidates) {
        if(pinned.ContainsKey(pid)) continue;
        uint snapshotParent=parents[pid];
        PinnedProcess parent;
        if(!pinned.TryGetValue(snapshotParent,out parent)) continue;
        IntPtr handle=OpenProcess(PROCESS_TERMINATE|PROCESS_SET_QUOTA|PROCESS_QUERY_LIMITED_INFORMATION, false, unchecked((int)pid));
        if(handle==IntPtr.Zero) { int error=Marshal.GetLastWin32Error(); if(error==87||error==1168) continue; return false; }
        long creation, exit, kernel, user;
        uint actualParent;
        if(!GetProcessTimes(handle,out creation,out exit,out kernel,out user) || creation<parent.creation || !ReadParent(handle,out actualParent) || actualParent!=snapshotParent) { CloseHandle(handle); continue; }
        bool alreadyInJob;
        if(!IsProcessInJob(handle,job,out alreadyInJob)) { CloseHandle(handle); return false; }
        if(!alreadyInJob && !AssignProcessToJobObject(job,handle)) { CloseHandle(handle); return false; }
        // Retaining each handle prevents its PID from being reused while the process tree is assembled.
        pinned[pid]=new PinnedProcess(handle,creation); added=true;
      }
      stable=added?0:stable+1;
      if(stable<2) System.Threading.Thread.Sleep(10);
    }
    if(stable<2) return false;
    Dictionary<uint,uint> finalParents=SnapshotParents();
    foreach(var pair in finalParents) if(pinned.ContainsKey(pair.Value) && !pinned.ContainsKey(pair.Key)) {
      IntPtr handle=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, unchecked((int)pair.Key));
      if(handle==IntPtr.Zero) { int error=Marshal.GetLastWin32Error(); if(error==87||error==1168) continue; return false; }
      try { bool inJob; if(!IsProcessInJob(handle,job,out inJob) || !inJob) return false; }
      finally { CloseHandle(handle); }
    }
    return true;
  }
  public static int Stop(int pid, ulong expectedTicks, string expectedHash) {
    IntPtr h=OpenProcess(PROCESS_TERMINATE|PROCESS_SET_QUOTA|PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if(h==IntPtr.Zero) { int e=Marshal.GetLastWin32Error(); return (e==87||e==1168)?0:-1; }
    IntPtr job=CreateJobObjectW(IntPtr.Zero,null);
    var pinned=new Dictionary<uint,PinnedProcess>();
    try {
      if(job==IntPtr.Zero) return -1;
      var limits=new ExtendedLimitInformation(); limits.basic.flags=JOB_KILL_ON_CLOSE;
      IntPtr memory=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(ExtendedLimitInformation)));
      try { Marshal.StructureToPtr(limits,memory,false); if(!SetInformationJobObject(job,JOB_EXTENDED_LIMIT_INFORMATION,memory,(uint)Marshal.SizeOf(typeof(ExtendedLimitInformation)))) return -1; }
      finally { Marshal.FreeHGlobal(memory); }
      long creation, exit, kernel, user;
      if(!GetProcessTimes(h,out creation,out exit,out kernel,out user)) return -1;
      ulong ticks=unchecked((ulong)(creation+FILETIME_EPOCH));
      if(ticks!=expectedTicks) return 2;
      uint size=32768; StringBuilder image=new StringBuilder((int)size);
      if(!QueryFullProcessImageName(h,0,image,ref size)) return -1;
      byte[] bytes=SHA256.Create().ComputeHash(Encoding.UTF8.GetBytes(image.ToString().ToLowerInvariant()));
      StringBuilder hash=new StringBuilder(); foreach(byte b in bytes) hash.Append(b.ToString("x2"));
      if(!String.Equals(hash.ToString(),expectedHash,StringComparison.OrdinalIgnoreCase)) return 2;
      if(!AssignProcessToJobObject(job,h)) return -1;
      pinned[(uint)pid]=new PinnedProcess(h,creation); h=IntPtr.Zero;
      if(!PinDescendants((uint)pid,job,pinned)) return -1;
      return TerminateJobObject(job,1)?1:-1;
    } finally { foreach(var process in pinned.Values) CloseHandle(process.handle); if(h!=IntPtr.Zero) CloseHandle(h); if(job!=IntPtr.Zero) CloseHandle(job); }
  }
}
'@; Add-Type -TypeDefinition $source -Language CSharp; [XystVerifiedStopper]::Stop(${identity.pid},[UInt64]::Parse('${identity.creation_time}'),'${identity.image_hash}')`;
  const result = await runProcess(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    timeoutMs: 15_000,
    maxOutputBytes: 8_192,
    env: safeProcessEnvironment({ ...process.env, SystemRoot: windowsSystemRoot }),
  });
  if (result.exitCode !== 0 || result.timedOut || result.truncated) return 'unavailable';
  const code = Number(result.stdout.trim());
  return code === 1 ? 'terminated' : code === 0 ? 'absent' : code === 2 ? 'mismatch' : 'unavailable';
}

/** Signal a recovered Linux process group while a pidfd pins its verified group leader. */
export async function terminateVerifiedLinuxProcessGroup(identity, signalName = 'SIGTERM') {
  if (
    process.platform !== 'linux' ||
    !identity ||
    identity.platform !== 'linux' ||
    !Number.isInteger(identity.pid) ||
    identity.pid < 1 ||
    (identity.process_group_id !== undefined && identity.process_group_id !== identity.pid) ||
    !/^[0-9a-f-]{16,64}$/i.test(identity.boot_id || '') ||
    !/^\d+$/.test(identity.start_ticks || '') ||
    !/^[0-9a-f]{64}$/i.test(identity.command_hash || '') ||
    !['SIGTERM', 'SIGKILL'].includes(signalName)
  )
    return 'unavailable';
  const script = [
    'import hashlib, os, signal, sys',
    'pid = int(sys.argv[1]); expected = (sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5])',
    'try: fd = os.pidfd_open(pid, 0)',
    'except ProcessLookupError:',
    '  try: os.killpg(pid, 0)',
    '  except ProcessLookupError: print("absent")',
    '  except PermissionError: print("unavailable")',
    '  else: print("unavailable")',
    '  raise SystemExit(0)',
    'except (AttributeError, OSError): print("unavailable"); raise SystemExit(0)',
    'try:',
    '  try:',
    '    boot = open("/proc/sys/kernel/random/boot_id", "rt", encoding="ascii").read().strip()',
    '    stat = open(f"/proc/{pid}/stat", "rt", encoding="ascii", errors="surrogateescape").read(); fields = stat[stat.rfind(")") + 1:].split(); state = fields[0]; group = fields[2]; start = fields[19]',
    '    command = open(f"/proc/{pid}/cmdline", "rb").read(); actual = (boot, start, group, hashlib.sha256(command).hexdigest())',
    '  except (OSError, IndexError, ValueError): print("unavailable"); raise SystemExit(0)',
    '  same_process = actual[0] == expected[0] and actual[1] == expected[1] and actual[2] == expected[2]',
    '  exited_leader = state == "Z" and command == b""',
    '  if not same_process or (actual[3] != expected[3] and not exited_leader): print("mismatch"); raise SystemExit(0)',
    '  try: os.killpg(pid, getattr(signal, sys.argv[6]))',
    '  except ProcessLookupError: print("absent"); raise SystemExit(0)',
    '  except PermissionError: print("unavailable"); raise SystemExit(0)',
    '  print("terminated")',
    'finally: os.close(fd)',
  ].join('\n');
  let result;
  try {
    result = await runProcess(
      'python3',
      [
        '-I',
        '-S',
        '-c',
        script,
        String(identity.pid),
        identity.boot_id,
        identity.start_ticks,
        String(identity.process_group_id ?? identity.pid),
        identity.command_hash,
        signalName,
      ],
      {
        timeoutMs: 5_000,
        maxOutputBytes: 1_024,
        env: safeProcessEnvironment(process.env),
      },
    );
  } catch {
    return 'unavailable';
  }
  if (result.exitCode !== 0 || result.timedOut || result.truncated) return 'unavailable';
  const outcome = result.stdout.trim();
  return ['terminated', 'absent', 'mismatch', 'unavailable'].includes(outcome) ? outcome : 'unavailable';
}

export function parseLinuxStartTicks(stat) {
  return parseLinuxProcessStat(stat).startTicks;
}

async function verifyLinuxProcessGroupAfterLeaderExit(identity) {
  const script = [
    'import os, sys',
    'pid = int(sys.argv[1])',
    'try: boot = open("/proc/sys/kernel/random/boot_id", "rt", encoding="ascii").read().strip()',
    'except OSError: print("unavailable"); raise SystemExit(0)',
    'if boot != sys.argv[2]: print("absent"); raise SystemExit(0)',
    'try: os.killpg(pid, 0)',
    'except ProcessLookupError: print("absent")',
    'except PermissionError: print("unavailable")',
    'else: print("unavailable")',
  ].join('\n');
  try {
    const result = await runProcess('python3', ['-I', '-S', '-c', script, String(identity.pid), identity.boot_id], {
      timeoutMs: 5_000,
      maxOutputBytes: 1_024,
      env: safeProcessEnvironment(process.env),
    });
    if (result.exitCode !== 0 || result.timedOut || result.truncated) return 'unavailable';
    const outcome = result.stdout.trim();
    return outcome === 'absent' || outcome === 'unavailable' ? outcome : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

function parseLinuxProcessStat(stat) {
  if (typeof stat !== 'string') throw new TypeError('Linux process stat must be text');
  const close = stat.lastIndexOf(')');
  if (close < 0) throw new TypeError('Linux process stat has no command delimiter');
  const fields = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const startTicks = fields[19]; // field 22 after pid and parenthesized comm
  const processGroupId = Number(fields[2]); // field 5 after pid and parenthesized comm
  if (!/^\d+$/.test(startTicks || '')) throw new TypeError('Linux process stat has an invalid start time');
  if (!/^[A-Za-z]$/.test(fields[0] || '')) throw new TypeError('Linux process stat has an invalid state');
  if (!Number.isSafeInteger(processGroupId) || processGroupId < 1) throw new TypeError('Linux process stat has an invalid process group');
  return { state: fields[0], startTicks, processGroupId };
}

async function linuxProcessExists(pid, procRoot) {
  try {
    await fs.access(path.join(procRoot, String(pid), 'stat'));
    return true;
  } catch (error) {
    return error.code === 'ENOENT' || error.code === 'ESRCH' ? false : null;
  }
}

async function readWindowsProcess(pid, systemRoot) {
  const executable = resolveWindowsPowerShellPath({ SystemRoot: systemRoot });
  if (!executable) throw new Error('SystemRoot is unavailable');
  const script = `$ErrorActionPreference='Stop'; try{$p=Get-Process -Id ${pid} -ErrorAction Stop}catch{$p=$null}; if($p){[pscustomobject]@{creation_time=[string]$p.StartTime.ToUniversalTime().Ticks;image_path=[string]$p.Path}|ConvertTo-Json -Compress}else{[Console]::Out.WriteLine('null')}`;
  const result = await runProcess(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    timeoutMs: 5_000,
    maxOutputBytes: 8_192,
    env: safeProcessEnvironment({ ...process.env, SystemRoot: systemRoot }),
  });
  if (result.exitCode !== 0 || result.timedOut || result.truncated) throw new Error('Could not query Windows process identity');
  if (result.stdout.trim() === 'null') return null;
  if (!result.stdout.trim()) throw new Error('Windows returned no process identity result');
  const parsed = JSON.parse(result.stdout);
  if (
    typeof parsed.creation_time !== 'string' ||
    !/^\d+$/.test(parsed.creation_time) ||
    typeof parsed.image_path !== 'string' ||
    !parsed.image_path
  )
    throw new Error('Windows returned an invalid process identity');
  return parsed;
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}
