//! Launch a child as its own TCC "responsible process".
//!
//! macOS attributes privacy permissions (Accessibility) of a child process to
//! the app that launched it. Pi runs in the Orbit Agent runtime, but without
//! this it would inherit Orbit as its responsible app — and Orbit's ad-hoc
//! signature changes on every release, so every update invalidated the grant.
//!
//! `orbit --orbit-disclaim-exec <program> [args...]` replaces itself (same pid,
//! stdio, cwd and environment) with `program` through `posix_spawn` with
//! `POSIX_SPAWN_SETEXEC` and a disclaimed responsibility attribute — the same
//! mechanism terminals and IDEs use. The Orbit Agent then answers for its own,
//! stable code signature, and the grant survives Orbit updates.

use std::ffi::{CString, OsString};
use std::os::unix::ffi::OsStrExt;

pub const FLAG: &str = "--orbit-disclaim-exec";

extern "C" {
    // libsystem, available since macOS 10.14 (declared in spawn_private.h).
    fn responsibility_spawnattrs_setdisclaim(
        attrs: *mut libc::posix_spawnattr_t,
        disclaim: libc::c_int,
    ) -> libc::c_int;
}

/// If invoked as the disclaim launcher, exec the target and never return.
pub fn exec_if_requested() {
    let args: Vec<OsString> = std::env::args_os().collect();
    if args.get(1).map(|arg| arg.as_bytes()) != Some(FLAG.as_bytes()) {
        return;
    }
    let target = &args[2..];
    if target.is_empty() {
        eprintln!("{FLAG}: missing program");
        std::process::exit(127);
    }
    let error = exec_disclaimed(target);
    eprintln!("{FLAG}: cannot launch {:?}: {error}", target[0]);
    std::process::exit(127);
}

fn exec_disclaimed(target: &[OsString]) -> std::io::Error {
    let to_c = |value: &[u8]| CString::new(value).map_err(|_| std::io::Error::other("argument contains NUL"));
    let argv: Vec<CString> = match target.iter().map(|arg| to_c(arg.as_bytes())).collect() {
        Ok(argv) => argv,
        Err(error) => return error,
    };
    let envp: Vec<CString> = match std::env::vars_os()
        .map(|(key, value)| {
            let mut pair = key.as_bytes().to_vec();
            pair.push(b'=');
            pair.extend_from_slice(value.as_bytes());
            to_c(&pair)
        })
        .collect()
    {
        Ok(envp) => envp,
        Err(error) => return error,
    };
    let mut argv_ptrs: Vec<*mut libc::c_char> = argv.iter().map(|arg| arg.as_ptr() as *mut _).collect();
    argv_ptrs.push(std::ptr::null_mut());
    let mut envp_ptrs: Vec<*mut libc::c_char> = envp.iter().map(|pair| pair.as_ptr() as *mut _).collect();
    envp_ptrs.push(std::ptr::null_mut());
    unsafe {
        let mut attrs: libc::posix_spawnattr_t = std::ptr::null_mut();
        let code = libc::posix_spawnattr_init(&mut attrs);
        if code != 0 {
            return std::io::Error::from_raw_os_error(code);
        }
        let code = libc::posix_spawnattr_setflags(&mut attrs, libc::POSIX_SPAWN_SETEXEC as libc::c_short);
        if code != 0 {
            libc::posix_spawnattr_destroy(&mut attrs);
            return std::io::Error::from_raw_os_error(code);
        }
        let code = responsibility_spawnattrs_setdisclaim(&mut attrs, 1);
        if code != 0 {
            libc::posix_spawnattr_destroy(&mut attrs);
            return std::io::Error::from_raw_os_error(code);
        }
        let mut pid: libc::pid_t = 0;
        // On success SETEXEC replaces this process image and does not return.
        let code = libc::posix_spawn(&mut pid, argv[0].as_ptr(), std::ptr::null(), &attrs, argv_ptrs.as_ptr(), envp_ptrs.as_ptr());
        libc::posix_spawnattr_destroy(&mut attrs);
        std::io::Error::from_raw_os_error(code)
    }
}
