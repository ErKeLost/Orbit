fn main() {
    // macOS 的 TCC 只看**运行中进程**的 Info.plist。`tauri dev` 直接跑
    // `target/debug/orbit`，外面没有 .app 包，于是系统读不到
    // NSMicrophoneUsageDescription，第一次 getUserMedia 就把进程 SIGABRT 掉
    // （崩溃报告里是 `Namespace TCC, Code 0`，主线程），而打包后的 .app 却是好的——
    // 这类"只有开发时崩"的问题最容易在别人的机器上重演一次。
    //
    // 把同一份 plist 用 `__TEXT,__info_plist` 段链进可执行文件，dev 跑起来才和
    // bundle 看到一样的声明。bundle 时 Tauri 写的是 app 包里的那份，两者不冲突。
    #[cfg(target_os = "macos")]
    {
        let plist = std::path::Path::new("Info.plist");
        println!("cargo:rerun-if-changed=Info.plist");
        if let Ok(path) = plist.canonicalize() {
            println!(
                "cargo:rustc-link-arg=-Wl,-sectcreate,__TEXT,__info_plist,{}",
                path.display()
            );
        }
    }
    tauri_build::build()
}
