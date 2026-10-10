package ai.pi.gui

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * Holds the pairing connection across the app being backgrounded.
 *
 * The phone's socket to the desktop is a `WebSocket` inside the WebView, and a
 * backgrounded app loses it twice over: `WryActivity.onPause` pauses the WebView
 * and its JavaScript timers, and Doze — or the cached-app freezer — closes what
 * is left. A foreground service is the only thing on modern Android that keeps a
 * process out of both, which is why this exists and why it costs a notification
 * that cannot be hidden: Android will not run this silently, by design.
 *
 * `connectedDevice` rather than `dataSync`, on purpose. Android 15 gave
 * `dataSync` a six-hour daily budget, after which the system stops the service
 * and refuses to restart it — the opposite of what this is for. `connectedDevice`
 * describes what this actually is (one paired device talking to another) and has
 * no such budget; its price is one of a short list of prerequisite permissions,
 * and `CHANGE_NETWORK_STATE` is the install-time one.
 *
 * Nothing here knows about sockets. It keeps the process (and with it the
 * WebView) alive; `MainActivity` is what keeps the WebView's timers running
 * while that is true.
 */
class ConnectionService : Service() {
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      stopSelf()
      return START_NOT_STICKY
    }
    return try {
      startForeground(NOTIFICATION_ID, notification())
      running = true
      START_STICKY
    } catch (error: Exception) {
      // Every failure here is one Android documents (a missing prerequisite
      // permission, a start from the background, a restricted type). Reporting it
      // beats a service that silently is not running while the setting says it is.
      running = false
      lastError = error.message ?: error.javaClass.simpleName
      stopSelf()
      START_NOT_STICKY
    }
  }

  override fun onDestroy() {
    running = false
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  private fun notification(): Notification {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val manager = getSystemService(NotificationManager::class.java)
      if (manager.getNotificationChannel(CHANNEL_ID) == null) {
        manager.createNotificationChannel(
          NotificationChannel(CHANNEL_ID, getString(R.string.connection_channel), NotificationManager.IMPORTANCE_LOW).apply {
            description = getString(R.string.connection_channel_description)
            setShowBadge(false)
          },
        )
      }
    }
    val open = PendingIntent.getActivity(
      this,
      0,
      Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
      PendingIntent.FLAG_IMMUTABLE,
    )
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.mipmap.ic_launcher)
      .setContentTitle(getString(R.string.connection_notification_title))
      .setContentText(getString(R.string.connection_notification_text))
      .setContentIntent(open)
      .setOngoing(true)
      .setShowWhen(false)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .build()
  }

  companion object {
    const val ACTION_START = "ai.pi.gui.connection.START"
    const val ACTION_STOP = "ai.pi.gui.connection.STOP"
    private const val CHANNEL_ID = "orbit-connection"
    private const val NOTIFICATION_ID = 4211

    /** Read by `MainActivity` to decide whether to keep the WebView's timers. */
    @Volatile
    var running: Boolean = false

    /** Why the last start failed, if it did. Cleared by a successful start. */
    @Volatile
    var lastError: String? = null

    fun start(context: Context): Boolean {
      lastError = null
      return try {
        ContextCompat.startForegroundService(
          context,
          Intent(context, ConnectionService::class.java).setAction(ACTION_START),
        )
        true
      } catch (error: Exception) {
        lastError = error.message ?: error.javaClass.simpleName
        false
      }
    }

    fun stop(context: Context) {
      running = false
      try {
        context.stopService(Intent(context, ConnectionService::class.java).setAction(ACTION_STOP))
      } catch (_: Exception) {
        // Nothing to do: the service was not running.
      }
    }
  }
}
