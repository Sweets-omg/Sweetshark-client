// Sweetshark per-window audio capture sidecar.
// Adapted from ripcord's capture sidecar — voice filter, push-to-talk, mic
// capture, and DeepFilterNet have all been removed.  Only per-window WASAPI
// process-loopback capture remains.
//
// IPC protocol: newline-delimited JSON over stdin/stdout.
// Audio frames are emitted as "audio_capture.frame" events (base64 f32le PCM)
// OR via the binary TCP egress port (length-prefixed raw f32le, much faster).
//
// Supported methods:
//   health.ping
//   capabilities.get
//   audio_targets.list          { sourceId? }
//   windows.resolve_source      { sourceId }
//   audio_capture.binary_egress_info
//   audio_capture.start         { sourceId?, appAudioTargetId? }
//   audio_capture.stop          { sessionId? }

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::VecDeque;
#[cfg(any(windows, test))]
use std::collections::HashMap;
use std::io::{self, BufRead, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

#[cfg(windows)]
use std::ffi::c_void;
#[cfg(windows)]
use std::mem::size_of;
#[cfg(windows)]
use std::path::Path;
#[cfg(windows)]
use std::ptr;
#[cfg(windows)]
use std::time::Instant;

#[cfg(windows)]
use windows::core::{IUnknown, Interface, PWSTR};
#[cfg(windows)]
use windows::Win32::Foundation::{BOOL, HANDLE, HWND, LPARAM, WAIT_TIMEOUT};
#[cfg(windows)]
use windows::Win32::Media::Audio::{
    ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
    IActivateAudioInterfaceCompletionHandler, IAudioCaptureClient, IAudioClient,
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_E_INVALID_STREAM_FLAG, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_LOOPBACK,
    AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, AUDIOCLIENT_ACTIVATION_PARAMS,
    AUDIOCLIENT_ACTIVATION_PARAMS_0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
    AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
    PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
    VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, WAVEFORMATEX,
};
#[cfg(windows)]
use windows::Win32::System::Com::{
    CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED,
};
#[cfg(windows)]
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, WaitForSingleObject, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
};
#[cfg(windows)]
use windows::Win32::System::Variant::VT_BLOB;
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindow, GetWindowLongW, GetWindowTextLengthW, GetWindowTextW,
    GetWindowThreadProcessId, IsWindow, IsWindowVisible, GWL_EXSTYLE, GW_OWNER, WS_EX_TOOLWINDOW,
};
#[cfg(windows)]
use windows_core::implement;

const TARGET_SAMPLE_RATE: u32 = 48_000;
const TARGET_CHANNELS: usize = 1;
const FRAME_SIZE: usize = 960; // 20ms at 48kHz
const PROTOCOL_VERSION: u32 = 1;
const PCM_ENCODING: &str = "f32le_base64";
const APP_AUDIO_BINARY_EGRESS_FRAMING: &str = "length_prefixed_f32le_v1";
const MAX_APP_AUDIO_BINARY_FRAME_BYTES: usize = 4 * 1024 * 1024;

// ── JSON-RPC types ────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct SidecarRequest {
    #[serde(default)]
    id: Option<String>,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Serialize)]
struct SidecarResponse<'a> {
    id: &'a str,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<SidecarError>,
}

#[derive(Debug, Serialize)]
struct SidecarError {
    message: String,
}

#[derive(Debug, Serialize)]
struct SidecarEvent<'a> {
    event: &'a str,
    params: Value,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AudioTarget {
    id: String,
    label: String,
    pid: u32,
    process_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveSourceParams {
    source_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListTargetsParams {
    source_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartAudioCaptureParams {
    source_id: Option<String>,
    app_audio_target_id: Option<String>,
    // When set, capture ALL system audio EXCEPT this PID's process tree.
    // Used for full-screen shares so the client itself isn't looped back.
    exclude_pid: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StopAudioCaptureParams {
    session_id: Option<String>,
}

// ── Capture session ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy)]
enum CaptureEndReason {
    #[cfg(windows)]
    CaptureStopped,
    #[cfg(windows)]
    AppExited,
    CaptureError,
    #[cfg(windows)]
    DeviceLost,
}

impl CaptureEndReason {
    fn as_str(self) -> &'static str {
        match self {
            #[cfg(windows)]
            Self::CaptureStopped => "capture_stopped",
            #[cfg(windows)]
            Self::AppExited => "app_exited",
            Self::CaptureError => "capture_error",
            #[cfg(windows)]
            Self::DeviceLost => "device_lost",
        }
    }
}

struct CaptureOutcome {
    reason: CaptureEndReason,
    error: Option<String>,
}

impl CaptureOutcome {
    #[cfg(windows)]
    fn from_reason(reason: CaptureEndReason) -> Self {
        Self { reason, error: None }
    }

    fn capture_error(error: String) -> Self {
        Self { reason: CaptureEndReason::CaptureError, error: Some(error) }
    }
}

struct CaptureSession {
    session_id: String,
    stop_flag: Arc<AtomicBool>,
    handle: JoinHandle<()>,
}

// ── Binary egress ─────────────────────────────────────────────────────────────

struct AppAudioBinaryEgress {
    port: u16,
    stream: Arc<Mutex<Option<TcpStream>>>,
    stop_flag: Arc<AtomicBool>,
    handle: JoinHandle<()>,
}

// ── Sidecar state ─────────────────────────────────────────────────────────────

#[derive(Default)]
struct SidecarState {
    capture_session: Option<CaptureSession>,
}

// ── Frame queue (async stdout writer) ─────────────────────────────────────────

#[derive(Default)]
struct FrameQueueState {
    queue: VecDeque<String>,
    closed: bool,
}

struct FrameQueue {
    capacity: usize,
    state: Mutex<FrameQueueState>,
    condvar: Condvar,
}

impl FrameQueue {
    fn new(capacity: usize) -> Self {
        Self {
            capacity,
            state: Mutex::new(FrameQueueState::default()),
            condvar: Condvar::new(),
        }
    }

    fn push_line(&self, line: String) {
        let mut lock = match self.state.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if lock.closed {
            return;
        }
        if lock.queue.len() >= self.capacity {
            let _ = lock.queue.pop_front();
        }
        lock.queue.push_back(line);
        self.condvar.notify_one();
    }

    fn pop_line(&self) -> Option<String> {
        let mut lock = match self.state.lock() {
            Ok(g) => g,
            Err(_) => return None,
        };
        loop {
            if let Some(line) = lock.queue.pop_front() {
                return Some(line);
            }
            if lock.closed {
                return None;
            }
            lock = match self.condvar.wait(lock) {
                Ok(g) => g,
                Err(_) => return None,
            };
        }
    }

    fn close(&self) {
        if let Ok(mut lock) = self.state.lock() {
            lock.closed = true;
            self.condvar.notify_all();
        }
    }
}

// ── Stdout helpers ────────────────────────────────────────────────────────────

fn write_json_line<T: Serialize>(stdout: &Arc<Mutex<io::Stdout>>, payload: &T) {
    let mut lock = match stdout.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    if let Ok(s) = serde_json::to_string(payload) {
        let _ = writeln!(lock, "{s}");
        let _ = lock.flush();
    }
}

fn write_response(stdout: &Arc<Mutex<io::Stdout>>, id: &str, result: Result<Value, String>) {
    match result {
        Ok(result_payload) => write_json_line(stdout, &SidecarResponse {
            id, ok: true, result: Some(result_payload), error: None,
        }),
        Err(message) => write_json_line(stdout, &SidecarResponse {
            id, ok: false, result: None, error: Some(SidecarError { message }),
        }),
    }
}

fn write_event(stdout: &Arc<Mutex<io::Stdout>>, event: &str, params: Value) {
    write_json_line(stdout, &SidecarEvent { event, params });
}

fn start_frame_writer(stdout: Arc<Mutex<io::Stdout>>, queue: Arc<FrameQueue>) -> JoinHandle<()> {
    thread::spawn(move || {
        while let Some(line) = queue.pop_line() {
            let mut lock = match stdout.lock() {
                Ok(g) => g,
                Err(_) => break,
            };
            let _ = writeln!(lock, "{line}");
            let _ = lock.flush();
        }
    })
}

fn now_unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

// ── Audio frame emission ──────────────────────────────────────────────────────

#[cfg(windows)]
fn enqueue_frame_event(
    queue: &Arc<FrameQueue>,
    session_id: &str,
    target_id: &str,
    sequence: u64,
    sample_rate: usize,
    frame_count: usize,
    pcm_base64: String,
) {
    let params = json!({
        "sessionId": session_id,
        "targetId": target_id,
        "sequence": sequence,
        "sampleRate": sample_rate,
        "channels": TARGET_CHANNELS,
        "frameCount": frame_count,
        "pcmBase64": pcm_base64,
        "protocolVersion": PROTOCOL_VERSION,
        "encoding": PCM_ENCODING,
    });

    if let Ok(s) = serde_json::to_string(&SidecarEvent { event: "audio_capture.frame", params }) {
        queue.push_line(s);
    }
}

#[cfg(windows)]
fn try_write_app_audio_binary_frame(
    stream_slot: &Arc<Mutex<Option<TcpStream>>>,
    session_id: &str,
    target_id: &str,
    sequence: u64,
    sample_rate: usize,
    channels: usize,
    frame_count: usize,
    protocol_version: u32,
    frame_samples: &[f32],
) -> bool {
    let session_id_bytes = session_id.as_bytes();
    let target_id_bytes = target_id.as_bytes();

    if session_id_bytes.is_empty() || session_id_bytes.len() > u16::MAX as usize { return false; }
    if target_id_bytes.is_empty() || target_id_bytes.len() > u16::MAX as usize { return false; }
    if sample_rate == 0 || channels == 0 || frame_count == 0 { return false; }
    if frame_samples.is_empty() { return false; }

    let pcm_bytes = bytemuck::cast_slice(frame_samples);

    let payload_len =
        2 + session_id_bytes.len() +
        2 + target_id_bytes.len() +
        8 + // sequence
        4 + // sample_rate
        2 + // channels
        4 + // frame_count
        4 + // protocol_version
        4 + // dropped_frame_count (always 0)
        4 + // pcm_byte_length
        pcm_bytes.len();

    if payload_len > MAX_APP_AUDIO_BINARY_FRAME_BYTES { return false; }

    let mut packet = Vec::with_capacity(4 + payload_len);
    packet.extend_from_slice(&(payload_len as u32).to_le_bytes());
    packet.extend_from_slice(&(session_id_bytes.len() as u16).to_le_bytes());
    packet.extend_from_slice(session_id_bytes);
    packet.extend_from_slice(&(target_id_bytes.len() as u16).to_le_bytes());
    packet.extend_from_slice(target_id_bytes);
    packet.extend_from_slice(&sequence.to_le_bytes());
    packet.extend_from_slice(&(sample_rate as u32).to_le_bytes());
    packet.extend_from_slice(&(channels as u16).to_le_bytes());
    packet.extend_from_slice(&(frame_count as u32).to_le_bytes());
    packet.extend_from_slice(&protocol_version.to_le_bytes());
    packet.extend_from_slice(&0u32.to_le_bytes()); // dropped_frame_count
    packet.extend_from_slice(&(pcm_bytes.len() as u32).to_le_bytes());
    packet.extend_from_slice(pcm_bytes);

    let mut lock = match stream_slot.lock() {
        Ok(l) => l,
        Err(_) => return false,
    };
    let Some(stream) = lock.as_mut() else { return false; };
    match stream.write_all(&packet) {
        Ok(()) => true,
        Err(e) => {
            eprintln!("[sweetshark-capture] binary egress write failed: {e}");
            *lock = None;
            false
        }
    }
}

// ── Windows: window enumeration ───────────────────────────────────────────────

#[cfg(any(windows, test))]
fn dedupe_window_entries_by_pid(entries: Vec<(u32, String)>) -> HashMap<u32, String> {
    let mut deduped: HashMap<u32, String> = HashMap::new();
    for (pid, title) in entries {
        deduped.entry(pid).or_insert(title);
    }
    deduped
}

#[cfg(any(windows, test))]
fn parse_window_source_id(source_id: &str) -> Option<isize> {
    let mut parts = source_id.split(':');
    if parts.next()? != "window" { return None; }
    let hwnd_part = parts.next()?;
    hwnd_part.parse::<isize>().ok()
}

fn parse_target_pid(target_id: &str) -> Option<u32> {
    target_id.strip_prefix("pid:").and_then(|raw| raw.parse::<u32>().ok())
}

#[cfg(windows)]
fn window_title(hwnd: HWND) -> Option<String> {
    let length = unsafe { GetWindowTextLengthW(hwnd) };
    if length <= 0 { return None; }
    let mut buf = vec![0u16; (length + 1) as usize];
    let read = unsafe { GetWindowTextW(hwnd, &mut buf) };
    if read <= 0 { return None; }
    Some(String::from_utf16_lossy(&buf[..read as usize]))
}

#[cfg(windows)]
fn is_user_visible_window(hwnd: HWND) -> bool {
    if !unsafe { IsWindowVisible(hwnd).as_bool() } { return false; }
    if unsafe { GetWindow(hwnd, GW_OWNER) }.ok().is_some_and(|o| !o.is_invalid()) {
        return false;
    }
    let ex_style = unsafe { GetWindowLongW(hwnd, GWL_EXSTYLE) };
    (ex_style & WS_EX_TOOLWINDOW.0 as i32) == 0
}

#[cfg(windows)]
fn process_name_from_pid(pid: u32) -> Option<String> {
    let process = unsafe {
        OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, false, pid)
    }.ok()?;

    let mut buffer = vec![0u16; 4096];
    let mut size = buffer.len() as u32;
    let success = unsafe {
        QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buffer.as_mut_ptr()), &mut size).is_ok()
    };
    let _ = unsafe { windows::Win32::Foundation::CloseHandle(process) };
    if !success { return None; }

    let full_path = String::from_utf16_lossy(&buffer[..size as usize]);
    Some(Path::new(&full_path)
        .file_name()
        .and_then(|v| v.to_str())
        .map(|v| v.to_string())
        .unwrap_or(full_path))
}

#[cfg(not(windows))]
fn process_name_from_pid(_pid: u32) -> Option<String> { None }

#[cfg(windows)]
unsafe extern "system" fn enum_windows_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
    if !is_user_visible_window(hwnd) { return BOOL(1); }
    let title = match window_title(hwnd) {
        Some(t) if !t.trim().is_empty() => t,
        _ => return BOOL(1),
    };
    let mut pid = 0u32;
    let _tid = GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid == 0 { return BOOL(1); }
    let entries_ptr = lparam.0 as *mut Vec<(u32, String)>;
    if !entries_ptr.is_null() {
        (*entries_ptr).push((pid, title));
    }
    BOOL(1)
}

#[cfg(windows)]
fn get_audio_targets() -> Vec<AudioTarget> {
    let mut entries: Vec<(u32, String)> = Vec::new();
    let _ = unsafe {
        EnumWindows(Some(enum_windows_callback), LPARAM((&mut entries as *mut Vec<(u32, String)>) as isize))
    };
    let deduped = dedupe_window_entries_by_pid(entries);
    let mut targets = Vec::new();
    for (pid, title) in deduped {
        let process_name = process_name_from_pid(pid).unwrap_or_else(|| "unknown.exe".to_string());
        let label = format!("{} - {} ({})", title.trim(), process_name, pid);
        targets.push(AudioTarget { id: format!("pid:{pid}"), label, pid, process_name });
    }
    targets.sort_by(|a, b| a.label.cmp(&b.label));
    targets
}

#[cfg(not(windows))]
fn get_audio_targets() -> Vec<AudioTarget> { Vec::new() }

#[cfg(windows)]
fn resolve_source_to_pid(source_id: &str) -> Option<u32> {
    let hwnd_value = parse_window_source_id(source_id)?;
    let hwnd = HWND(hwnd_value as *mut c_void);
    if !unsafe { IsWindow(hwnd).as_bool() } { return None; }
    let mut pid = 0u32;
    unsafe { let _ = GetWindowThreadProcessId(hwnd, Some(&mut pid)); }
    if pid == 0 { None } else { Some(pid) }
}

#[cfg(not(windows))]
fn resolve_source_to_pid(_source_id: &str) -> Option<u32> { None }

// ── Windows: process loopback activation ─────────────────────────────────────

#[cfg(windows)]
fn process_is_alive(process_handle: HANDLE) -> bool {
    unsafe { WaitForSingleObject(process_handle, 0) == WAIT_TIMEOUT }
}

#[cfg(windows)]
fn open_process_for_liveness(pid: u32) -> Option<HANDLE> {
    unsafe {
        OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, false, pid)
    }.ok()
}

#[cfg(windows)]
#[implement(IActivateAudioInterfaceCompletionHandler)]
struct ActivateAudioInterfaceCallback {
    signal: Arc<(Mutex<bool>, Condvar)>,
}

#[cfg(windows)]
impl ActivateAudioInterfaceCallback {
    fn new(signal: Arc<(Mutex<bool>, Condvar)>) -> Self {
        Self { signal }
    }
}

#[cfg(windows)]
impl windows::Win32::Media::Audio::IActivateAudioInterfaceCompletionHandler_Impl
    for ActivateAudioInterfaceCallback_Impl
{
    fn ActivateCompleted(
        &self,
        _op: Option<&IActivateAudioInterfaceAsyncOperation>,
    ) -> windows::core::Result<()> {
        let (lock, condvar) = &*self.signal;
        if let Ok(mut done) = lock.lock() {
            *done = true;
            condvar.notify_all();
        }
        Ok(())
    }
}

#[cfg(windows)]
fn activate_process_loopback_client(
    target_pid: u32,
    exclude: bool,
) -> Result<IAudioClient, String> {
    let signal = Arc::new((Mutex::new(false), Condvar::new()));
    let callback: IActivateAudioInterfaceCompletionHandler =
        ActivateAudioInterfaceCallback::new(Arc::clone(&signal)).into();

    let loopback_mode = if exclude {
        PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE
    } else {
        PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
    };

    let mut activation_params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: target_pid,
                ProcessLoopbackMode: loopback_mode,
            },
        },
    };

    let activation_prop = windows_core::imp::PROPVARIANT {
        Anonymous: windows_core::imp::PROPVARIANT_0 {
            Anonymous: windows_core::imp::PROPVARIANT_0_0 {
                vt: VT_BLOB.0,
                wReserved1: 0,
                wReserved2: 0,
                wReserved3: 0,
                Anonymous: windows_core::imp::PROPVARIANT_0_0_0 {
                    blob: windows_core::imp::BLOB {
                        cbSize: size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
                        pBlobData: (&mut activation_params as *mut AUDIOCLIENT_ACTIVATION_PARAMS)
                            .cast::<u8>(),
                    },
                },
            },
        },
    };
    let activation_prop_ptr = (&activation_prop as *const windows_core::imp::PROPVARIANT)
        .cast::<windows_core::PROPVARIANT>();

    let operation = unsafe {
        ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID,
            Some(activation_prop_ptr),
            &callback,
        )
        .map_err(|e| format!("ActivateAudioInterfaceAsync failed: {e}"))?
    };

    let (lock, condvar) = &*signal;
    let done_guard = lock.lock().map_err(|_| "Failed to lock activate callback".to_string())?;
    let (done_guard, _) = condvar
        .wait_timeout_while(done_guard, Duration::from_secs(5), |done| !*done)
        .map_err(|_| "Failed waiting for activate callback".to_string())?;
    if !*done_guard {
        return Err("ActivateAudioInterfaceAsync timed out".to_string());
    }

    let mut activate_result = Default::default();
    let mut activated_interface: Option<IUnknown> = None;
    unsafe {
        operation
            .GetActivateResult(&mut activate_result, &mut activated_interface)
            .map_err(|e| format!("GetActivateResult failed: {e}"))?
    };
    activate_result.ok().map_err(|e| format!("Activation returned failure HRESULT: {e}"))?;

    activated_interface
        .ok_or_else(|| "Activation returned no interface".to_string())?
        .cast::<IAudioClient>()
        .map_err(|e| format!("Activated interface is not IAudioClient: {e}"))
}

// ── Windows: capture loop ─────────────────────────────────────────────────────

#[cfg(windows)]
fn capture_loopback_audio(
    session_id: &str,
    target_id: &str,
    target_pid: u32,
    exclude: bool,          // true = capture all audio EXCEPT target_pid's tree
    stop_flag: Arc<AtomicBool>,
    frame_queue: Arc<FrameQueue>,
    binary_stream: Option<Arc<Mutex<Option<TcpStream>>>>,
) -> CaptureOutcome {
    // In exclude mode we're capturing system-wide audio, not a specific app,
    // so there's no target process to wait on for liveness.
    let process_handle = if !exclude {
        match open_process_for_liveness(target_pid) {
            Some(h) => Some(h),
            None => return CaptureOutcome::from_reason(CaptureEndReason::AppExited),
        }
    } else {
        None
    };

    let com_initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).is_ok() };

    let reason = (|| {
        let audio_client = activate_process_loopback_client(target_pid, exclude)?;
        let capture_format = WAVEFORMATEX {
            wFormatTag: 0x0003, // WAVE_FORMAT_IEEE_FLOAT
            nChannels: TARGET_CHANNELS as u16,
            nSamplesPerSec: TARGET_SAMPLE_RATE,
            nAvgBytesPerSec: TARGET_SAMPLE_RATE * TARGET_CHANNELS as u32 * 4,
            nBlockAlign: (TARGET_CHANNELS * 4) as u16,
            wBitsPerSample: 32,
            cbSize: 0,
        };

        let init_result = unsafe {
            audio_client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK
                    | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                    | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                20 * 10_000, // 20ms buffer
                0,
                &capture_format,
                None,
            )
        };

        if let Err(e) = init_result {
            if e.code() == AUDCLNT_E_INVALID_STREAM_FLAG {
                return Err(format!("Failed to initialize loopback client: {e} (invalid flags for process loopback)"));
            }
            return Err(format!("Failed to initialize loopback client: {e}"));
        }

        let capture_client: IAudioCaptureClient = unsafe {
            audio_client.GetService().map_err(|e| format!("Failed to get IAudioCaptureClient: {e}"))?
        };

        unsafe { audio_client.Start().map_err(|e| format!("Failed to start audio client: {e}"))? };

        let mut pending = Vec::<f32>::new();
        let mut sequence: u64 = 0;
        let mut last_liveness = Instant::now();

        loop {
            if stop_flag.load(Ordering::Relaxed) {
                let _ = unsafe { audio_client.Stop() };
                return Ok(CaptureEndReason::CaptureStopped);
            }

            if last_liveness.elapsed() >= Duration::from_millis(300) {
                if let Some(h) = process_handle {
                    if !process_is_alive(h) {
                        let _ = unsafe { audio_client.Stop() };
                        return Ok(CaptureEndReason::AppExited);
                    }
                }
                last_liveness = Instant::now();
            }

            let mut packet_size = match unsafe { capture_client.GetNextPacketSize() } {
                Ok(s) => s,
                Err(_) => {
                    let _ = unsafe { audio_client.Stop() };
                    return Ok(CaptureEndReason::DeviceLost);
                }
            };

            if packet_size == 0 {
                thread::sleep(Duration::from_millis(4));
                continue;
            }

            while packet_size > 0 {
                let mut data_ptr: *mut u8 = ptr::null_mut();
                let mut frame_count = 0u32;
                let mut flags = 0u32;

                if unsafe {
                    capture_client.GetBuffer(&mut data_ptr, &mut frame_count, &mut flags, None, None)
                }.is_err() {
                    let _ = unsafe { audio_client.Stop() };
                    return Ok(CaptureEndReason::CaptureError);
                }

                let chunk = if (flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0 {
                    vec![0.0f32; frame_count as usize * TARGET_CHANNELS]
                } else {
                    let sample_count = frame_count as usize * TARGET_CHANNELS;
                    unsafe { std::slice::from_raw_parts(data_ptr as *const f32, sample_count) }.to_vec()
                };

                pending.extend_from_slice(&chunk);
                let _ = unsafe { capture_client.ReleaseBuffer(frame_count) };

                while pending.len() >= FRAME_SIZE * TARGET_CHANNELS {
                    let frame_samples: Vec<f32> = pending.drain(..FRAME_SIZE * TARGET_CHANNELS).collect();

                    let wrote_binary = binary_stream.as_ref().map(|slot| {
                        try_write_app_audio_binary_frame(
                            slot,
                            session_id,
                            target_id,
                            sequence,
                            TARGET_SAMPLE_RATE as usize,
                            TARGET_CHANNELS,
                            FRAME_SIZE,
                            PROTOCOL_VERSION,
                            &frame_samples,
                        )
                    }).unwrap_or(false);

                    if !wrote_binary {
                        let pcm_base64 = BASE64.encode(bytemuck::cast_slice(&frame_samples));
                        enqueue_frame_event(
                            &frame_queue,
                            session_id,
                            target_id,
                            sequence,
                            TARGET_SAMPLE_RATE as usize,
                            FRAME_SIZE,
                            pcm_base64,
                        );
                    }

                    sequence = sequence.saturating_add(1);
                }

                packet_size = match unsafe { capture_client.GetNextPacketSize() } {
                    Ok(s) => s,
                    Err(_) => {
                        let _ = unsafe { audio_client.Stop() };
                        return Ok(CaptureEndReason::DeviceLost);
                    }
                };
            }
        }
    })();

    if let Some(h) = process_handle {
        let _ = unsafe { windows::Win32::Foundation::CloseHandle(h) };
    }
    if com_initialized {
        unsafe { CoUninitialize() };
    }

    match reason {
        Ok(r) => CaptureOutcome::from_reason(r),
        Err(e) => {
            eprintln!("[sweetshark-capture] capture error targetId={} targetPid={}: {}", target_id, target_pid, e);
            CaptureOutcome::capture_error(e)
        }
    }
}

#[cfg(not(windows))]
fn capture_loopback_audio(
    _session_id: &str,
    _target_id: &str,
    _target_pid: u32,
    _exclude: bool,
    _stop_flag: Arc<AtomicBool>,
    _frame_queue: Arc<FrameQueue>,
    _binary_stream: Option<Arc<Mutex<Option<TcpStream>>>>,
) -> CaptureOutcome {
    CaptureOutcome::capture_error("Per-app audio capture is only available on Windows.".to_string())
}

// ── Session management ────────────────────────────────────────────────────────

fn start_capture_thread(
    stdout: Arc<Mutex<io::Stdout>>,
    frame_queue: Arc<FrameQueue>,
    binary_stream: Option<Arc<Mutex<Option<TcpStream>>>>,
    session_id: String,
    target_id: String,
    target_pid: u32,
    exclude: bool,
    stop_flag: Arc<AtomicBool>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        let outcome = capture_loopback_audio(
            &session_id,
            &target_id,
            target_pid,
            exclude,
            Arc::clone(&stop_flag),
            Arc::clone(&frame_queue),
            binary_stream,
        );

        let mut ended_params = json!({
            "sessionId": session_id,
            "targetId": target_id,
            "reason": outcome.reason.as_str(),
            "protocolVersion": PROTOCOL_VERSION,
        });
        if let Some(e) = outcome.error {
            ended_params["error"] = json!(e);
        }
        write_event(&stdout, "audio_capture.ended", ended_params);
    })
}

fn stop_capture_session(state: &mut SidecarState, requested_session_id: Option<&str>) {
    let Some(active) = state.capture_session.take() else { return; };
    let should_stop = requested_session_id
        .map(|id| id == active.session_id)
        .unwrap_or(true);
    if should_stop {
        active.stop_flag.store(true, Ordering::Relaxed);
        let _ = active.handle.join();
    } else {
        state.capture_session = Some(active);
    }
}

// ── Binary egress server ──────────────────────────────────────────────────────

fn start_app_audio_binary_egress() -> Result<AppAudioBinaryEgress, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| format!("Failed to bind binary egress listener: {e}"))?;
    listener.set_nonblocking(true)
        .map_err(|e| format!("Failed to configure binary egress listener: {e}"))?;
    let port = listener.local_addr()
        .map_err(|e| format!("Failed to read binary egress port: {e}"))?.port();

    let stream = Arc::new(Mutex::new(None::<TcpStream>));
    let worker_stream = Arc::clone(&stream);
    let stop_flag = Arc::new(AtomicBool::new(false));
    let worker_stop = Arc::clone(&stop_flag);

    let handle = thread::spawn(move || {
        while !worker_stop.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((accepted, _)) => {
                    let _ = accepted.set_nodelay(true);
                    let _ = accepted.set_write_timeout(Some(Duration::from_millis(15)));
                    if let Ok(mut lock) = worker_stream.lock() {
                        *lock = Some(accepted);
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(25));
                }
                Err(e) => {
                    eprintln!("[sweetshark-capture] binary egress accept error: {e}");
                    thread::sleep(Duration::from_millis(100));
                }
            }
        }
        if let Ok(mut lock) = worker_stream.lock() { *lock = None; }
    });

    Ok(AppAudioBinaryEgress { port, stream, stop_flag, handle })
}

// ── RPC handlers ──────────────────────────────────────────────────────────────

fn handle_health_ping() -> Result<Value, String> {
    Ok(json!({
        "status": "ok",
        "timestampMs": now_unix_ms(),
        "protocolVersion": PROTOCOL_VERSION,
    }))
}

fn handle_capabilities_get() -> Result<Value, String> {
    Ok(json!({
        "platform": std::env::consts::OS,
        "perAppAudio": if cfg!(windows) { "supported" } else { "unsupported" },
        "protocolVersion": PROTOCOL_VERSION,
        "encoding": PCM_ENCODING,
    }))
}

fn handle_windows_resolve_source(params: Value) -> Result<Value, String> {
    let parsed: ResolveSourceParams =
        serde_json::from_value(params).map_err(|e| format!("invalid params: {e}"))?;
    let pid = resolve_source_to_pid(&parsed.source_id);
    Ok(json!({ "sourceId": parsed.source_id, "pid": pid }))
}

fn handle_audio_targets_list(params: Value) -> Result<Value, String> {
    let parsed: ListTargetsParams =
        serde_json::from_value(params).map_err(|e| format!("invalid params: {e}"))?;
    let targets = get_audio_targets();
    let suggested_target_id = parsed.source_id.as_deref()
        .and_then(resolve_source_to_pid)
        .map(|pid| format!("pid:{pid}"));
    Ok(json!({
        "targets": targets,
        "suggestedTargetId": suggested_target_id,
        "protocolVersion": PROTOCOL_VERSION,
    }))
}

fn handle_audio_capture_binary_egress_info(egress: &AppAudioBinaryEgress) -> Result<Value, String> {
    Ok(json!({
        "port": egress.port,
        "framing": APP_AUDIO_BINARY_EGRESS_FRAMING,
        "protocolVersion": PROTOCOL_VERSION,
    }))
}

fn handle_audio_capture_start(
    stdout: Arc<Mutex<io::Stdout>>,
    frame_queue: Arc<FrameQueue>,
    binary_stream: Option<Arc<Mutex<Option<TcpStream>>>>,
    state: &mut SidecarState,
    params: Value,
) -> Result<Value, String> {
    if !cfg!(windows) {
        return Err("Per-app audio capture is only available on Windows.".to_string());
    }

    let parsed: StartAudioCaptureParams =
        serde_json::from_value(params).map_err(|e| format!("invalid params: {e}"))?;

    stop_capture_session(state, None);

    // ── Exclude mode: system-wide audio minus one process (e.g. the client) ──
    if let Some(excl_pid) = parsed.exclude_pid {
        let target_id = format!("excl:pid:{excl_pid}");
        let process_name = process_name_from_pid(excl_pid).unwrap_or_else(|| "unknown.exe".to_string());
        let session_id = Uuid::new_v4().to_string();
        eprintln!("[sweetshark-capture] start exclude-mode session={} excludePid={} process={}", session_id, excl_pid, process_name);

        let stop_flag = Arc::new(AtomicBool::new(false));
        let handle = start_capture_thread(
            stdout,
            frame_queue,
            binary_stream,
            session_id.clone(),
            target_id.clone(),
            excl_pid,
            true, // exclude mode
            Arc::clone(&stop_flag),
        );
        state.capture_session = Some(CaptureSession { session_id: session_id.clone(), stop_flag, handle });
        return Ok(json!({
            "sessionId": session_id,
            "targetId": target_id,
            "mode": "exclude",
            "sampleRate": TARGET_SAMPLE_RATE,
            "channels": TARGET_CHANNELS,
            "framesPerBuffer": FRAME_SIZE,
            "protocolVersion": PROTOCOL_VERSION,
            "encoding": PCM_ENCODING,
        }));
    }

    // ── Include mode: capture a specific process ──────────────────────────────
    let source_pid = parsed.source_id.as_deref()
        .and_then(resolve_source_to_pid)
        .map(|pid| format!("pid:{pid}"));

    let target_id = parsed.app_audio_target_id
        .or(source_pid)
        .ok_or_else(|| "No app audio target provided and source mapping failed".to_string())?;

    let target_pid =
        parse_target_pid(&target_id).ok_or_else(|| "Invalid app audio target id".to_string())?;

    let target_exists = get_audio_targets().iter().any(|t| t.id == target_id);
    if !target_exists {
        return Err(format!("Target process with pid {target_pid} is not available"));
    }

    let session_id = Uuid::new_v4().to_string();
    let process_name = process_name_from_pid(target_pid).unwrap_or_else(|| "unknown.exe".to_string());
    eprintln!("[sweetshark-capture] start session={} targetId={} targetPid={} process={}", session_id, target_id, target_pid, process_name);

    let stop_flag = Arc::new(AtomicBool::new(false));
    let handle = start_capture_thread(
        stdout,
        frame_queue,
        binary_stream,
        session_id.clone(),
        target_id.clone(),
        target_pid,
        false, // include mode
        Arc::clone(&stop_flag),
    );

    state.capture_session = Some(CaptureSession { session_id: session_id.clone(), stop_flag, handle });

    Ok(json!({
        "sessionId": session_id,
        "targetId": target_id,
        "mode": "include",
        "sampleRate": TARGET_SAMPLE_RATE,
        "channels": TARGET_CHANNELS,
        "framesPerBuffer": FRAME_SIZE,
        "protocolVersion": PROTOCOL_VERSION,
        "encoding": PCM_ENCODING,
    }))
}

fn handle_audio_capture_stop(state: &mut SidecarState, params: Value) -> Result<Value, String> {
    let parsed: StopAudioCaptureParams =
        serde_json::from_value(params).map_err(|e| format!("invalid params: {e}"))?;
    stop_capture_session(state, parsed.session_id.as_deref());
    Ok(json!({ "stopped": true, "protocolVersion": PROTOCOL_VERSION }))
}

// ── Entry point ───────────────────────────────────────────────────────────────

fn main() {
    eprintln!("[sweetshark-capture] starting");

    let stdin = io::stdin();
    let stdout = Arc::new(Mutex::new(io::stdout()));
    let frame_queue = Arc::new(FrameQueue::new(100));
    let frame_writer = start_frame_writer(Arc::clone(&stdout), Arc::clone(&frame_queue));
    let state = Arc::new(Mutex::new(SidecarState::default()));

    let binary_egress = match start_app_audio_binary_egress() {
        Ok(e) => {
            eprintln!("[sweetshark-capture] binary egress listening on 127.0.0.1:{}", e.port);
            Some(e)
        }
        Err(e) => {
            eprintln!("[sweetshark-capture] binary egress unavailable: {e}");
            None
        }
    };

    for line in stdin.lock().lines() {
        let Ok(line) = line else { break; };
        if line.trim().is_empty() { continue; }

        let request: SidecarRequest = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[sweetshark-capture] invalid request json: {e}");
                continue;
            }
        };

        let req_stdout = Arc::clone(&stdout);
        let req_queue = Arc::clone(&frame_queue);

        let result = match request.method.as_str() {
            "health.ping" => handle_health_ping(),
            "capabilities.get" => handle_capabilities_get(),
            "windows.resolve_source" => handle_windows_resolve_source(request.params),
            "audio_targets.list" => handle_audio_targets_list(request.params),
            "audio_capture.binary_egress_info" => match binary_egress.as_ref() {
                Some(e) => handle_audio_capture_binary_egress_info(e),
                None => Err("Binary egress is unavailable".to_string()),
            },
            "audio_capture.start" => match state.lock() {
                Ok(mut s) => handle_audio_capture_start(
                    req_stdout.clone(),
                    req_queue,
                    binary_egress.as_ref().map(|e| Arc::clone(&e.stream)),
                    &mut s,
                    request.params,
                ),
                Err(_) => Err("State lock poisoned".to_string()),
            },
            "audio_capture.stop" => match state.lock() {
                Ok(mut s) => handle_audio_capture_stop(&mut s, request.params),
                Err(_) => Err("State lock poisoned".to_string()),
            },
            _ => Err(format!("Unknown method: {}", request.method)),
        };

        if let Some(id) = request.id.as_deref() {
            write_response(&req_stdout, id, result);
        } else if let Err(e) = result {
            eprintln!("[sweetshark-capture] notification method={} failed: {}", request.method, e);
        }
    }

    // Cleanup
    if let Some(e) = binary_egress {
        e.stop_flag.store(true, Ordering::Relaxed);
        let _ = e.handle.join();
    }
    if let Ok(mut s) = state.lock() {
        stop_capture_session(&mut s, None);
    }
    frame_queue.close();
    let _ = frame_writer.join();

    eprintln!("[sweetshark-capture] stopping");
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::{dedupe_window_entries_by_pid, parse_target_pid, parse_window_source_id};

    #[test]
    fn parses_window_source_id() {
        assert_eq!(parse_window_source_id("window:1337:0"), Some(1337));
        assert_eq!(parse_window_source_id("screen:3:0"), None);
        assert_eq!(parse_window_source_id("window:not-a-number:0"), None);
    }

    #[test]
    fn parses_target_pid() {
        assert_eq!(parse_target_pid("pid:4321"), Some(4321));
        assert_eq!(parse_target_pid("pid:abc"), None);
        assert_eq!(parse_target_pid("4321"), None);
    }

    #[test]
    fn dedupes_by_pid() {
        let d = dedupe_window_entries_by_pid(vec![
            (100, "First".into()),
            (100, "Second".into()),
            (200, "Other".into()),
        ]);
        assert_eq!(d.get(&100).map(String::as_str), Some("First"));
        assert_eq!(d.get(&200).map(String::as_str), Some("Other"));
    }
}
