package ai.pi.gui

import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

/**
 * Start and stop [ConnectionService], and say whether it is actually running.
 *
 * `status` reports the service's own state rather than what was last asked for:
 * an Android start can be refused (a missing prerequisite permission, a start
 * from the background), and a setting that says "on" while nothing is holding
 * the connection is worse than one that says it failed.
 *
 * The result is a plain map on purpose. `Invoke.resolveObject` serializes with
 * Jackson, which would take an `org.json.JSONObject` apart field by field rather
 * than by its contents.
 */
@TauriPlugin
class ConnectionPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun start(invoke: Invoke) {
    if (ConnectionService.start(activity)) {
      invoke.resolveObject(status())
      return
    }
    invoke.reject(ConnectionService.lastError ?: "无法启动连接服务")
  }

  @Command
  fun stop(invoke: Invoke) {
    ConnectionService.stop(activity)
    invoke.resolveObject(status())
  }

  @Command
  fun status(invoke: Invoke) {
    invoke.resolveObject(status())
  }

  private fun status(): Map<String, Any?> =
    mapOf("running" to ConnectionService.running, "error" to ConnectionService.lastError)
}
