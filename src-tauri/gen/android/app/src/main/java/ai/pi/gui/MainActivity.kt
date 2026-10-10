package ai.pi.gui

import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
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
    keepComposerAboveKeyboard(webView)
    dispatchBackToThePage(webView)
  }

  /**
   * Keep the composer above the keyboard.
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
   * Only the IME inset is applied. The system bars are already the page's
   * business through `env(safe-area-inset-*)`, so padding those here as well
   * would double the gap whenever the keyboard is closed.
   */
  private fun keepComposerAboveKeyboard(webView: WebView) {
    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
      val parent = view.parent as? View
      if (parent != null && parent.paddingBottom != ime) {
        parent.setPadding(parent.paddingLeft, parent.paddingTop, parent.paddingRight, ime)
      }
      insets
    }
    ViewCompat.requestApplyInsets(webView)
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
