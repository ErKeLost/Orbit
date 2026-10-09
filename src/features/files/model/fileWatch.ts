import { invoke } from "../../../lib/native";

/**
 * 打开中文件的磁盘变更感知。
 *
 * 编辑器把正在显示的路径注册进来，这里每 2.5 秒轮询一次 mtime/size；
 * 变化（或被删除）就广播失效信号，订阅方（编辑器）各自决定要不要重读。
 * 轮询而不是 fs watcher：一条 RPC 生态复用（桌面与手机同一条命令），
 * 且天然覆盖所有改动来源——Agent 工具、bash 重定向、git 操作。
 */

type FileMeta = { mtimeMs: number; size: number };

const listeners = new Set<(paths?: string[]) => void>();
const watched = new Map<string, FileMeta>();
const POLL_MS = 2_500;
const PENDING = { mtimeMs: -1, size: -1 };

let timer: ReturnType<typeof setInterval> | null = null;

function emit(paths?: string[]) {
  for (const listener of listeners) listener(paths);
}

function statFile(path: string): Promise<FileMeta | null> {
  return invoke<FileMeta | null>("file_meta", { path }).catch(() => null);
}

/** 订阅失效信号。`paths` 缺省表示"全部文件"。返回取消订阅函数。 */
export function onFilesInvalidated(listener: (paths?: string[]) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** git 操作等已知变更的立即失效（无轮询延迟）。 */
export function invalidateWatchedFiles(paths?: string[]) {
  emit(paths);
}

/**
 * 编辑器注册正在显示的路径。返回注销函数；最后一个路径注销后轮询停止。
 * 首次注册会先取一次基线 mtime，之后的轮询只对真正的变化发信号。
 */
export function watchFilePath(path: string): () => void {
  const known = watched.get(path);
  if (!known) {
    watched.set(path, PENDING);
    void statFile(path).then((meta) => {
      // 基线取回前若已注销（标签被关了）就不写回，避免常驻一个幽灵路径。
      if (watched.get(path) === PENDING) watched.set(path, meta ?? { mtimeMs: 0, size: 0 });
    });
  }
  if (!timer) timer = setInterval(() => void poll(), POLL_MS);
  return () => {
    watched.delete(path);
    if (watched.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

async function poll() {
  for (const [path, prev] of [...watched]) {
    const meta = await statFile(path);
    if (!meta) {
      // 文件从磁盘上消失（被删/被 git 操作移走）也是一种要反映的变更。
      if (prev !== PENDING) {
        watched.delete(path);
        emit([path]);
      }
      continue;
    }
    const changed =
      prev !== PENDING && (prev.mtimeMs !== meta.mtimeMs || prev.size !== meta.size);
    watched.set(path, meta);
    if (changed) emit([path]);
  }
}
