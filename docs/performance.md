# Performance measurements

Xyst records local inference latency, token throughput, response outcomes, and verified task outcomes when local metrics are enabled. Use `xyst lm stats [model-key]` to inspect those measurements. `xyst lm resources` and the desktop Model dock report host RAM and available NVIDIA VRAM; those readings describe the host running Xyst, not model-attributed usage.

## Packaged dashboard benchmark

Run `scripts/benchmark-desktop-snapshot.mjs` against the bundled Node executable and CLI entry extracted from a Windows NSIS package or mounted Linux AppImage:

```powershell
node scripts/benchmark-desktop-snapshot.mjs `
  --runtime "<package>\resources\app.asar.unpacked\apps\desktop\runtime\node.exe" `
  --cli "<package>\resources\app.asar.unpacked\apps\cli\dist\index.js" `
  --samples 8
```

```sh
node scripts/benchmark-desktop-snapshot.mjs \
  --runtime /tmp/.mount_Xyst-XXXX/resources/app.asar.unpacked/apps/desktop/runtime/node \
  --cli /tmp/.mount_Xyst-XXXX/resources/app.asar.unpacked/apps/cli/dist/index.js \
  --samples 8
```

The benchmark starts a fresh CLI process for each sample, uses a new temporary app-data and workspace root, and sets `LM_STUDIO_BASE_URL` to unused loopback port 9. It cannot contact a configured live LM Studio instance and sends no model request or inference. The first sample is reported as cold; following samples retain the isolated SQLite database. Results include elapsed time, output bytes, and the host RAM/VRAM snapshot returned by the CLI. The script has an 8 MiB output bound and a 30-second per-sample timeout, and deletes only its unique temporary directory after verifying it is directly under the OS temp directory.

These numbers measure CLI process startup plus dashboard snapshot assembly. They do not measure Electron renderer paint, model inference, installation, or Xyst-attributed GPU/RAM consumption. Compare runs only on comparable hosts and package builds.

### 2026-10-25 release baseline

Both measurements used the 0.1.0 Windows NSIS and Linux x64 AppImage CLI/runtime entries on the same Windows host and its Ubuntu 24.04 WSL distribution. The historical eight-sample runs used an isolated local HTTP 503 stub with no model or inference; they predate the current port-9 benchmark behavior and are not directly comparable with the run below:

| Platform | Bundled Node | Cold | Seven warm samples | Median warm | Snapshot output |
| --- | --- | ---: | ---: | ---: | ---: |
| Windows 11 x64 | 24.20.0 | 507.0 ms | 490.8–503.0 ms | 497.4 ms | 6,126 bytes |
| Ubuntu 24.04 WSL x64 | 22.12.0 | 528.4 ms | 510.3–577.3 ms | 543.8 ms | 5,977 bytes |

The Linux RAM and NVIDIA VRAM values are WSL/host readings at one sample time; they are recorded in [verification history](verification-history.md). They are not directly comparable to Windows memory accounting.

### Current packaged payload benchmark (2026-10-25)

Current-package results below use the exact current Windows unpacked NSIS payload and Linux AppImage SquashFS payload. The benchmark sets LM Studio to unused loopback port 9, uses fresh temporary data, and makes no model request. These can be compared with other runs of this benchmark revision on the same platform; they are not directly comparable to the older 503-stub baseline above.

| Platform | Bundled Node | Cold | Seven warm samples | Median warm | Snapshot output |
| --- | --- | ---: | ---: | ---: | ---: |
| Windows 11 x64 | 24.20.0 | 547.7 ms | 521.6–542.1 ms | 528.8 ms | 6,334 bytes |
| Ubuntu 24.04 WSL x64 | 22.12.0 | 625.9 ms | 547.3–593.5 ms | 557.2 ms | 6,181 bytes |

Detailed package identities and endpoint isolation are recorded in [verification history](verification-history.md#current-packaged-dashboard-benchmark-with-port-9-2026-10-25).

The desktop dashboard refresh was consolidated from 50+ separate CLI launches to one `desktop snapshot` invocation. This is a process-launch-count reduction; there is no pre-change wall-clock baseline, so no wall-time speedup is claimed.

## Renderer code splitting (2026-10-25)

The terminal route now dynamically imports xterm and its fit addon. Production builds produced a 307.91 kB initial JavaScript chunk (88.51 kB gzip) and a separate 335.53 kB terminal chunk (85.35 kB gzip). Before the split, the initial renderer chunk was 642.81 kB (173.19 kB gzip). This cuts the initial JavaScript transfer by about 52% raw and 49% gzip; opening Terminal downloads its chunk on demand. Total available JavaScript remains similar, and no paint-time improvement is claimed because this pass measured bundle sizes rather than renderer startup timing.
