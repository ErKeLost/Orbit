package ai.pi.gui

import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
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
   * Keep the composer above the keyboard.
   *
   * A WebView is never resized for the IME on its own: the activity draws
   * edge-to-edge, and Android 15+ stopped resizing the window when the keyboard
   * appears. A 100%-tall shell therefore keeps its full height and the input
   * row ends up *under* the keyboard — the phone's composer was unreachable.
   *
   * Padding the WebView's parent (the activity's content frame, where
   * `setContentView` puts it) is what actually resizes it: the layout viewport
   * shrinks to the visible area, exactly as it does on a desktop window, and no
   * JavaScript is needed to know where the keyboard is. The web side keeps
   * `--keyboard-inset` as a fallback for shells that resize the visual viewport
   * instead (iOS, the browser preview); it computes 0 here, because the viewport
   * it measures has already shrunk.
   *
   * Only the IME inset is applied. The system bars are already accounted for by
   * `env(safe-area-inset-*)` in the page, so padding them here as well would
   * double the gap whenever the keyboard is closed.
   */
  override fun onWebViewCreate(webView: WebView) {
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
