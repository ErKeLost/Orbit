//! Private, session-scoped transport from Pi to Orbit's in-process AX engine.
//! The model process never receives native AX handles. Each authenticated
//! connection gets its own observation ledger inside `ax_worker::serve`.

use std::{
    collections::HashSet,
    fs,
    io::{self, BufRead, BufReader, Read, Write},
    os::unix::{
        fs::DirBuilderExt,
        io::AsRawFd,
        net::{UnixListener, UnixStream},
    },
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, MutexGuard,
    },
    thread,
    time::Duration,
};
use uuid::Uuid;

pub struct AxBroker {
    directory: PathBuf,
    socket: PathBuf,
    token: String,
    stop: Arc<AtomicBool>,
    allowed_pids: Arc<Mutex<HashSet<u32>>>,
}

pub struct AxPermit {
    pid: u32,
    allowed_pids: Arc<Mutex<HashSet<u32>>>,
}

impl Drop for AxPermit {
    fn drop(&mut self) {
        lock(&self.allowed_pids).remove(&self.pid);
    }
}

const DIRECTORY_PREFIX: &str = "orbit-ax-";

/// A poisoned lock only means another session panicked; the PID set itself is
/// always consistent, so keep serving instead of propagating the panic.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Remove socket directories left by earlier Orbit processes. Tauri managed
/// state is not dropped on a normal quit, and crashes never clean up, so do it
/// on startup. Only this user's directories whose socket nobody accepts on are
/// removed; a concurrently running Orbit keeps its own.
fn remove_stale_directories() {
    let Ok(entries) = fs::read_dir("/tmp") else { return };
    let uid = unsafe { libc::getuid() };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if !name.to_string_lossy().starts_with(DIRECTORY_PREFIX) {
            continue;
        }
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else { continue };
        use std::os::unix::fs::MetadataExt;
        if !metadata.is_dir() || metadata.uid() != uid {
            continue;
        }
        let socket = path.join("rpc");
        if UnixStream::connect(&socket).is_ok() {
            continue;
        }
        let _ = fs::remove_file(&socket);
        let _ = fs::remove_dir(&path);
    }
}

impl AxBroker {
    pub fn start() -> io::Result<Self> {
        // A private directory protects the socket before the client sends its
        // per-process secret. /tmp keeps the Unix socket path below macOS's
        // short sockaddr_un limit even when the user's home path is long.
        remove_stale_directories();
        let directory = PathBuf::from("/tmp").join(format!("{DIRECTORY_PREFIX}{}", Uuid::new_v4().simple()));
        fs::DirBuilder::new().mode(0o700).create(&directory)?;
        let socket = directory.join("rpc");
        let listener = match UnixListener::bind(&socket) {
            Ok(listener) => listener,
            Err(error) => {
                let _ = fs::remove_dir(&directory);
                return Err(error);
            }
        };
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let stop = Arc::new(AtomicBool::new(false));
        let server_stop = stop.clone();
        let server_token = token.clone();
        let allowed_pids = Arc::new(Mutex::new(HashSet::new()));
        let server_allowed = allowed_pids.clone();
        // Blocking accept: no idle polling. `shutdown` wakes it with a
        // throwaway connection after setting the stop flag.
        thread::Builder::new().name("orbit-ax-broker".into()).spawn(move || {
            for stream in listener.incoming() {
                if server_stop.load(Ordering::Relaxed) {
                    break;
                }
                let Ok(stream) = stream else { continue };
                let token = server_token.clone();
                let allowed = server_allowed.clone();
                let _ = thread::Builder::new().name("orbit-ax-session".into()).spawn(move || {
                    // An AX/FFI panic must end only this session, never Orbit.
                    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        serve_client(stream, &token, &allowed)
                    }));
                });
            }
        })?;
        Ok(Self {
            directory,
            socket,
            token,
            stop,
            allowed_pids,
        })
    }

    pub fn socket(&self) -> &std::path::Path {
        &self.socket
    }
    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn permit(&self, pid: u32) -> AxPermit {
        lock(&self.allowed_pids).insert(pid);
        AxPermit {
            pid,
            allowed_pids: self.allowed_pids.clone(),
        }
    }
}

impl AxBroker {
    /// Stop accepting connections and remove the socket directory. Called
    /// from the app's exit event because managed state is never dropped.
    pub fn shutdown(&self) {
        if self.stop.swap(true, Ordering::Relaxed) {
            return;
        }
        let _ = UnixStream::connect(&self.socket);
        let _ = fs::remove_file(&self.socket);
        let _ = fs::remove_dir(&self.directory);
    }
}

impl Drop for AxBroker {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn peer_pid(stream: &UnixStream) -> io::Result<u32> {
    let mut pid: libc::pid_t = 0;
    let mut size = std::mem::size_of::<libc::pid_t>() as libc::socklen_t;
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_LOCAL,
            libc::LOCAL_PEERPID,
            (&mut pid as *mut libc::pid_t).cast(),
            &mut size,
        )
    };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    u32::try_from(pid)
        .map_err(|_| io::Error::new(io::ErrorKind::PermissionDenied, "invalid peer pid"))
}

fn serve_client(
    mut stream: UnixStream,
    token: &str,
    allowed_pids: &Mutex<HashSet<u32>>,
) -> io::Result<()> {
    let pid = peer_pid(&stream)?;
    // The token is inherited by Pi's ordinary shell tools. Verify the kernel
    // peer PID too, so those children cannot use the host AX capability.
    if !lock(allowed_pids).contains(&pid) {
        return Ok(());
    }
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut authentication = Vec::new();
    let count = (&mut reader)
        .take(512)
        .read_until(b'\n', &mut authentication)?;
    if count == 0 || !authentication.ends_with(b"\n") {
        return Ok(());
    }
    let valid = serde_json::from_slice::<serde_json::Value>(&authentication)
        .ok()
        .and_then(|value| {
            value
                .get("token")
                .and_then(|item| item.as_str())
                .map(str::to_owned)
        })
        .is_some_and(|provided| provided == token);
    if !valid {
        return Ok(());
    }
    stream.set_read_timeout(None)?;
    reader.get_ref().set_read_timeout(None)?;
    stream.write_all(b"{\"ready\":true}\n")?;
    stream.flush()?;
    crate::ax_worker::serve(reader, stream);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn broker_rejects_wrong_token_and_serves_valid_protocol() {
        let broker = AxBroker::start().unwrap();
        let mut unlisted = UnixStream::connect(broker.socket()).unwrap();
        unlisted
            .write_all(format!("{{\"token\":\"{}\"}}\n", broker.token()).as_bytes())
            .unwrap();
        unlisted
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        assert_eq!(unlisted.read(&mut [0]).unwrap(), 0);
        let _permit = broker.permit(std::process::id());
        let mut wrong = UnixStream::connect(broker.socket()).unwrap();
        wrong.write_all(b"{\"token\":\"wrong\"}\n").unwrap();
        wrong
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut byte = [0];
        assert_eq!(wrong.read(&mut byte).unwrap(), 0);

        let mut stream = UnixStream::connect(broker.socket()).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        stream
            .write_all(format!("{{\"token\":\"{}\"}}\n", broker.token()).as_bytes())
            .unwrap();
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&line).unwrap()["ready"],
            true
        );
        reader
            .get_mut()
            .write_all(b"{\"id\":1,\"command\":\"invalid\",\"app\":\"Calculator\"}\n")
            .unwrap();
        line.clear();
        reader.read_line(&mut line).unwrap();
        let response: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(response["id"], 1);
        assert_eq!(response["error"]["code"], "AX_ERROR");
    }

    #[test]
    fn startup_removes_stale_socket_directories_only() {
        let stale = PathBuf::from("/tmp").join(format!("{DIRECTORY_PREFIX}test-stale-{}", Uuid::new_v4().simple()));
        fs::DirBuilder::new().mode(0o700).create(&stale).unwrap();
        let live = AxBroker::start().unwrap();
        assert!(!stale.exists(), "stale directory was not removed");
        let second = AxBroker::start().unwrap();
        assert!(live.socket().exists(), "a live broker's socket must survive another startup");
        second.shutdown();
        live.shutdown();
        assert!(!live.socket().exists());
    }

    #[test]
    #[ignore = "requires a visible Calculator window and Accessibility trust for the test runner"]
    fn live_broker_observes_calculator_in_host_process() {
        let broker = AxBroker::start().unwrap();
        let _permit = broker.permit(std::process::id());
        let mut stream = UnixStream::connect(broker.socket()).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        stream
            .write_all(format!("{{\"token\":\"{}\"}}\n", broker.token()).as_bytes())
            .unwrap();
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&line).unwrap()["ready"],
            true
        );
        fn send(
            reader: &mut BufReader<UnixStream>,
            command: serde_json::Value,
        ) -> serde_json::Value {
            reader
                .get_mut()
                .write_all(format!("{command}\n").as_bytes())
                .unwrap();
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            serde_json::from_str(&line).unwrap()
        }
        let launched = send(
            &mut reader,
            serde_json::json!({"id": 1, "command": "launch", "app": "Calculator"}),
        );
        assert_eq!(launched["ok"], true, "{launched}");
        for (step, button) in ["全部清除", "2", "+", "3", "="].iter().enumerate() {
            let snapshot = send(
                &mut reader,
                serde_json::json!({"id": 2 + step * 2, "command": "snapshot", "app": "Calculator"}),
            );
            assert_eq!(snapshot["ok"], true, "{snapshot}");
            fn find_button<'a>(node: &'a serde_json::Value, name: &str) -> Option<&'a serde_json::Value> {
                if node["name"] == name && node["actions"].as_array().is_some_and(|actions| actions.iter().any(|action| action == "press")) {
                    return Some(node);
                }
                node["children"].as_array()?.iter().find_map(|child| find_button(child, name))
            }
            let target = find_button(&snapshot["data"]["tree"], button)
                .unwrap_or_else(|| panic!("Calculator button {button} missing"));
            let action = send(
                &mut reader,
                serde_json::json!({"id": 3 + step * 2, "command": "action", "app": "Calculator", "operation": "press", "ref": target["ref_id"]}),
            );
            assert_eq!(action["ok"], true, "{button}: {action}");
        }
        let final_snapshot = send(
            &mut reader,
            serde_json::json!({"id": 20, "command": "snapshot", "app": "Calculator"}),
        );
        assert_eq!(final_snapshot["ok"], true, "{final_snapshot}");
        assert_eq!(
            final_snapshot["data"]["tree"]["children"][0]["children"][0]["children"][0]["value"],
            "5"
        );
    }
}
