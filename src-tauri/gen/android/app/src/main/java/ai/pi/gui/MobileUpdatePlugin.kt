package ai.pi.gui

import android.app.Activity
import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class InstallUpdateArgs {
  lateinit var url: String
  lateinit var version: String
}

@TauriPlugin
class MobileUpdatePlugin(private val activity: Activity) : Plugin(activity) {
  private var downloadId: Long? = null
  private var pendingApk: File? = null
  private var pendingInvoke: Invoke? = null
  private var waitingForInstallPermission = false

  private val receiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      val completed = intent?.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L)
      if (completed == downloadId) finishDownload(completed ?: -1L)
    }
  }

  @Command
  fun install(invoke: Invoke) {
    try {
      if (pendingInvoke != null) {
        invoke.reject("已有 Android 更新正在下载")
        return
      }
      val args = invoke.parseArgs(InstallUpdateArgs::class.java)
      val expected = "https://github.com/ErKeLost/Orbit/releases/download/v${args.version}/orbit-android-arm64-v${args.version}.apk"
      if (args.url != expected || !args.version.matches(Regex("\\d+\\.\\d+\\.\\d+"))) {
        invoke.reject("Android 更新地址无效")
        return
      }

      val downloads = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
        ?: throw IllegalStateException("Android 下载目录不可用")
      val fileName = "Orbit-Android-v${args.version}.apk"
      val apk = File(downloads, fileName)
      if (apk.exists() && !apk.delete()) throw IllegalStateException("无法替换旧更新包")

      val request = DownloadManager.Request(Uri.parse(args.url))
        .setTitle("Orbit ${args.version}")
        .setDescription("正在下载 Android 更新")
        .setMimeType(APK_MIME)
        .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
        .setDestinationInExternalFilesDir(activity, Environment.DIRECTORY_DOWNLOADS, fileName)
        .setAllowedOverMetered(true)
        .setAllowedOverRoaming(false)

      registerReceiver()
      pendingApk = apk
      pendingInvoke = invoke
      downloadId = (activity.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager).enqueue(request)
    } catch (error: Exception) {
      clearPending()
      invoke.reject(error.message ?: "Android 更新下载失败")
    }
  }

  override fun onResume() {
    if (!waitingForInstallPermission) return
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || activity.packageManager.canRequestPackageInstalls()) {
      waitingForInstallPermission = false
      pendingApk?.let(::launchInstaller)
    }
  }

  override fun onDestroy(activity: androidx.appcompat.app.AppCompatActivity) {
    pendingInvoke?.reject("Android 更新已取消")
    clearPending()
  }

  private fun finishDownload(id: Long) {
    val manager = activity.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
    val cursor = manager.query(DownloadManager.Query().setFilterById(id))
    val status = cursor.use {
      if (!it.moveToFirst()) DownloadManager.STATUS_FAILED
      else it.getInt(it.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
    }
    if (status != DownloadManager.STATUS_SUCCESSFUL) {
      pendingInvoke?.reject("Android 更新下载失败")
      clearPending()
      return
    }

    val apk = pendingApk ?: run {
      pendingInvoke?.reject("Android 更新包不可用")
      clearPending()
      return
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !activity.packageManager.canRequestPackageInstalls()) {
      waitingForInstallPermission = true
      activity.startActivity(Intent(
        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
        Uri.parse("package:${activity.packageName}"),
      ))
      return
    }
    launchInstaller(apk)
  }

  private fun launchInstaller(apk: File) {
    try {
      val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", apk)
      val intent = Intent(Intent.ACTION_VIEW)
        .setDataAndType(uri, APK_MIME)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
      activity.startActivity(intent)
      pendingInvoke?.resolve()
      clearPending()
    } catch (error: Exception) {
      pendingInvoke?.reject(error.message ?: "无法打开 Android 安装程序")
      clearPending()
    }
  }

  private fun registerReceiver() {
    val filter = IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      activity.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
    } else {
      @Suppress("DEPRECATION")
      activity.registerReceiver(receiver, filter)
    }
  }

  private fun clearPending() {
    try { activity.unregisterReceiver(receiver) } catch (_: IllegalArgumentException) {}
    downloadId = null
    pendingApk = null
    pendingInvoke = null
    waitingForInstallPermission = false
  }

  companion object {
    private const val APK_MIME = "application/vnd.android.package-archive"
  }
}
