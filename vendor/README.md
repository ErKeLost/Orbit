# vendor

只放打过补丁、并且会被 Orbit 编译进去的上游 crate。只用来阅读的 git submodule 在 `references/`。

| 目录 | 来源 | 补丁 |
| --- | --- | --- |
| `portable-pty/` | wezterm `portable-pty` 0.9.0 | Windows 上把子进程放进 job。见 `portable-pty/UPSTREAM.md` |
| `tauri-plugin-global-shortcut/` | tauri-apps/plugins-workspace `835adce` | CEF 下避开 PluginStore 死锁。见 `tauri-plugin-global-shortcut/README.orbit.md` |

`src-tauri/Cargo.toml` 用 path 依赖这两个目录。不要在 `vendor/` 根上再放一份 crate 源码。
