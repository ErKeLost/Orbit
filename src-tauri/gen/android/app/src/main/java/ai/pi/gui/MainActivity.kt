package ai.pi.gui

import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // The barcode-scanner plugin layers its native camera preview BENEATH the
    // WebView; an opaque WebView hides it (black viewfinder). Make the WebView
    // transparent once attached so the preview shows through page areas whose
    // HTML background is transparent.
    window.decorView.post { findWebView(window.decorView)?.setBackgroundColor(Color.TRANSPARENT) }
  }

  /**
   * Back belongs to the page, not to the WebView's history.
   *
   * Wry's default — `canGoBack() ? goBack() : onBackPressed()` — asks a question
   * this app never answers yes to: it is a single-page shell, so back meant
   * "leave the app" from anywhere, including with the drawer open or a file on
   * screen. The page decides instead (`src/lib/back-gesture.ts`): an overlay
   * claims the press while it is open, and only a press nobody wants leaves.
   */
  override val handleBackNavigation: Boolean = false

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    webView.addJavascriptInterface(SystemBarInsets(webView), "orbitNative")
    applyWindowInsets(webView)
    dispatchBackToThePage(webView)
  }

  /**
   * Keep the page's JavaScript running while the app is not on screen, but only
   * while the connection service is holding the process.
   *
   * `WryActivity.onPause` calls `WebView.onPause`, which pauses the page's
   * timers — and the pairing socket is a page-level `WebSocket`, so its heartbeat
   * and its dispatch stop with them. `resumeTimers` is Android's documented way
   * to keep them going while the UI is not visible, and it is deliberately tied
   * to the service: without the service the process is frozen anyway, and
   * keeping timers alive would only burn battery to lose the socket slightly
   * later.
   */
  override fun onPause() {
    super.onPause()
    if (ConnectionService.running) webView?.resumeTimers()
  }

  private var webView: WebView? = null

  /** The last insets pushed to the page, so a layout pass is not a re-push. */
  private var pushedInsetTop = -1
  private var pushedInsetBottom = -1

  /**
   * Keep the composer above the keyboard, and hand the system bars to the page.
   *
   * A WebView is never resized for the IME on its own: the activity draws
   * edge-to-edge, and Android 15+ stopped resizing the window when the keyboard
   * appears. A 100%-tall shell therefore keeps its full height and the input row
   * ends up *under* the keyboard — the composer was unreachable.
   *
   * Padding the WebView's parent (the activity's content frame, which is where
   * wry's `setContentView` puts it) is what actually resizes it: the layout
   * viewport shrinks to the visible area and no JavaScript has to know where the
   * keyboard is. The web side keeps `--keyboard-inset` for shells that resize
   * the *visual* viewport instead (iOS, the browser preview); it computes 0 here,
   * because the viewport it measures has already shrunk.
   *
   * Only the IME inset pads the parent. The system bars are the page's business
   * (`publishSystemBarInsets` below), so padding those here as well would double
   * the gap whenever the keyboard is closed.
   */
  private fun applyWindowInsets(webView: WebView) {
    // One listener for both insets: a second `setOnApplyWindowInsetsListener` on
    // the same view would replace this one, and the composer would go back under
    // the keyboard or the title bar back under the clock.
    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
      val parent = view.parent as? View
      if (parent != null && parent.paddingBottom != ime) {
        parent.setPadding(parent.paddingLeft, parent.paddingTop, parent.paddingRight, ime)
      }
      publishSystemBarInsets(view, insets)
      insets
    }
    ViewCompat.requestApplyInsets(webView)
  }

  /**
   * Tell the page how tall the system bars are.
   *
   * `env(safe-area-inset-top)` is the display *cutout* in an Android WebView,
   * not the status bar, so it is 0 on every phone without a notch — and the
   * mobile title bar then draws under the clock, where the system keeps the
   * touches. `--android-inset-top` / `--android-inset-bottom` carry the insets
   * Android itself reports, and the stylesheet takes whichever is larger.
   *
   * Pushed on every change, and pulled by the page on mount through
   * `orbitNative.insets()`: the push can happen before the page's script runs,
   * the pull cannot.
   */
  private fun publishSystemBarInsets(view: View, insets: WindowInsetsCompat) {
    val css = cssSystemBarInsets(view, insets)
    if (css.first == pushedInsetTop && css.second == pushedInsetBottom) return
    pushedInsetTop = css.first
    pushedInsetBottom = css.second
    webView?.evaluateJavascript("window.__orbitInsets && window.__orbitInsets(${css.first}, ${css.second})", null)
  }

  /** The bars in CSS pixels: the layout viewport's unit, not the display's. */
  private fun cssSystemBarInsets(view: View, insets: WindowInsetsCompat): Pair<Int, Int> {
    val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
    val density = view.resources.displayMetrics.density.let { if (it > 0f) it else 1f }
    return Math.round(bars.top / density) to Math.round(bars.bottom / density)
  }

  private inner class SystemBarInsets(private val view: WebView) {
    @JavascriptInterface
    fun insets(): String {
      val insets = ViewCompat.getRootWindowInsets(view) ?: return "0,0"
      val css = cssSystemBarInsets(view, insets)
      return "${css.first},${css.second}"
    }
  }

  /**
   * Ask the page whether it wants this back press; leave only if it does not.
   *
   * The answer crosses an IPC boundary and so arrives asynchronously, which
   * decides the shape of this: the press is consumed here either way, and an
   * unclaimed one is replayed as the system's own — that replay being what makes
   * the app exit. Disabling this callback around the replay is not optional:
   * without it `onBackPressed()` would dispatch straight back into this method.
   */
  private fun dispatchBackToThePage(webView: WebView) {
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        webView.evaluateJavascript("window.__orbitBack ? window.__orbitBack() : false") { answer ->
          if (answer == "true") return@evaluateJavascript
          isEnabled = false
          onBackPressed()
          isEnabled = true
        }
      }
    })
  }

  private fun findWebView(view: View?): WebView? {
    if (view is WebView) return view
    if (view is ViewGroup) {
      for (index in 0 until view.childCount) {
        findWebView(view.getChildAt(index))?.let { return it }
      }
    }
    return null
  }
}
