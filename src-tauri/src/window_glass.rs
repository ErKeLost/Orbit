//! Window glass: the desktop the page paints for itself.
//!
//! The window cannot be see-through on this runtime, and clearing the page does
//! not change that. The desktop app renders in CEF's *windowed* mode, and CEF
//! only enables transparent painting for windowless (off-screen) browsers:
//! `cef_browser_settings_t.background_color` documents that an alpha-0 page for
//! a windowed browser falls back to `cef_settings_t.background_color`, and an
//! alpha-0 value *there* becomes opaque white. `Emulation
//! .setDefaultBackgroundColorOverride` — what this module used to send through
//! DevTools — clears the *document's* background (it is the
//! transparent-screenshot switch, `Page.captureScreenshot omitBackground`), not
//! the compositor fill. So the `NSVisualEffectView` installed under the page was
//! always covered, and re-sending the override at 180/520/900 ms could not win
//! against a fill that is opaque by contract.
//!
//! So the window stays opaque and the page paints the desktop itself: this file
//! captures what is *behind* the window (every window below it inside the
//! window's own rect) and hands it over as a JPEG. The page blurs it and washes
//! it with the theme colour, which turns both sliders into plain CSS — the blur
//! radius and the opacity never cross IPC — and one capture per move, resize or
//! focus keeps the sample current.
//!
//! `CGWindowListCreateImage` is deprecated on macOS 14 in favour of
//! ScreenCaptureKit. It is kept here because it is synchronous, one call, and
//! already returns exactly "what is below this window"; ScreenCaptureKit streams
//! would need a filter per display and a run loop for the same rectangle.

use serde::{Deserialize, Serialize};
use tauri::WebviewWindow;

#[derive(Clone, Copy, Deserialize)]
pub struct Rgb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

/// One capture of the desktop behind the window.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlassSample {
    /// Base64 JPEG of the window's rect, desktop composited underneath.
    pub data: String,
    pub width: u32,
    pub height: u32,
}

/// The page's own background colour, kept so a sample's uncovered corners fall
/// back to the window colour instead of black.
static FALLBACK: std::sync::Mutex<Rgb> = std::sync::Mutex::new(Rgb { r: 18, g: 19, b: 23 });

fn fallback() -> Rgb {
    *FALLBACK.lock().unwrap_or_else(|error| error.into_inner())
}

/// Glass state for the window itself.
///
/// Returns `false`: no native tint is painted any more, so the page must not
/// assume a second wash behind it. The command stays because the window still
/// has to be made opaque here (CEF's window is created non-opaque from
/// `transparent: true`, and a transparent window would show the real desktop
/// sliding under a sample that lags a frame behind), and because Windows still
/// gets its acrylic from it.
#[tauri::command]
pub fn set_window_glass_enabled(
    window: WebviewWindow,
    enabled: bool,
    background: Rgb,
    opacity: Option<f64>,
) -> bool {
    if let Ok(mut slot) = FALLBACK.lock() {
        *slot = background;
    }
    #[cfg(target_os = "macos")]
    {
        let paint = window.clone();
        let color = background;
        let _ = macos::on_main(&window, move || macos::keep_opaque(&paint, color));
        let _ = (enabled, opacity);
        false
    }
    #[cfg(not(target_os = "macos"))]
    {
        let alpha = if enabled {
            (opacity.unwrap_or(1.0).clamp(0.0, 1.0) * 255.0).round() as u8
        } else {
            255
        };
        let _ = window.set_background_color(Some(tauri::window::Color(
            background.r,
            background.g,
            background.b,
            alpha,
        )));
        false
    }
}

/// Kept for the shared command surface: the wry build (`--features glass-wry`)
/// uses this radius on the window's vibrancy backing. This build blurs in CSS
/// instead, so the page's `--sidebar-blur` already did the work.
#[tauri::command]
pub fn set_window_background_blur(window: WebviewWindow, radius: u32) {
    let _ = (window, radius);
}

/// The desktop behind this window, encoded for the page's glass layer.
///
/// Called when the glass toggle turns on and whenever the window moves, resizes,
/// changes scale or comes back to the front, because the desktop behind a moved
/// window is a different picture. The capture and the JPEG encode run off the UI
/// thread, so a window drag never waits on them.
#[tauri::command]
pub async fn glass_desktop_sample(window: WebviewWindow) -> Result<Option<GlassSample>, String> {
    #[cfg(target_os = "macos")]
    {
        let target_window = window.clone();
        let target = macos::on_main(&window, move || macos::window_target(&target_window))
            .ok_or_else(|| "窗口不可用".to_string())??;
        let color = fallback();
        let sample = tauri::async_runtime::spawn_blocking(move || macos::capture(&target, color))
            .await
            .map_err(|error| format!("桌面取样线程失败：{error}"))??;
        Ok(Some(sample))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        // `None` = this build has no sampling; the page keeps painting itself.
        Ok(None)
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{GlassSample, Rgb};
    use std::ffi::c_void;

    use objc2::rc::Retained;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSColor, NSScreen, NSView, NSWindow};
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use tauri::WebviewWindow;

    /// Everything the capture needs, read on the main thread so the blocking
    /// part never touches AppKit.
    pub struct Target {
        window_id: u32,
        /// The window's rect in CoreGraphics' global space: origin at the top
        /// left of the main display, y growing down.
        rect: CGRect,
    }

    // ---- CoreGraphics -------------------------------------------------
    // Declared here on purpose: these five entry points are stable C ABI, and
    // the typed wrappers in `objc2-core-graphics` need binding features this
    // crate does not build (CGImage, CGContext). The structs come from
    // `objc2-core-foundation`, which does match the C layout.
    type CGImageRef = *mut c_void;
    type CGContextRef = *mut c_void;
    type CGColorSpaceRef = *mut c_void;

    const OPTION_ON_SCREEN_BELOW_WINDOW: u32 = 1 << 2;
    const IMAGE_BOUNDS_IGNORE_FRAMING: u32 = 1 << 0;
    const IMAGE_SHOULD_BE_OPAQUE: u32 = 1 << 1;
    const IMAGE_NOMINAL_RESOLUTION: u32 = 1 << 4;
    /// `kCGImageAlphaPremultipliedLast` — RGBA in memory.
    const ALPHA_PREMULTIPLIED_LAST: u32 = 1;
    /// `kCGBitmapByteOrder32Big` — the byte order the JPEG encoder expects.
    const BITMAP_BYTE_ORDER_32_BIG: u32 = 4 << 12;

    extern "C" {
        fn CGWindowListCreateImage(
            screen_bounds: CGRect,
            list_option: u32,
            window_id: u32,
            image_option: u32,
        ) -> CGImageRef;
        fn CGImageGetWidth(image: CGImageRef) -> usize;
        fn CGImageGetHeight(image: CGImageRef) -> usize;
        fn CGImageRelease(image: CGImageRef);
        fn CGColorSpaceCreateDeviceRGB() -> CGColorSpaceRef;
        fn CGColorSpaceRelease(space: CGColorSpaceRef);
        fn CGBitmapContextCreate(
            data: *mut c_void,
            width: usize,
            height: usize,
            bits_per_component: usize,
            bytes_per_row: usize,
            space: CGColorSpaceRef,
            bitmap_info: u32,
        ) -> CGContextRef;
        fn CGContextDrawImage(context: CGContextRef, rect: CGRect, image: CGImageRef);
        fn CGContextRelease(context: CGContextRef);
    }

    pub fn on_main<T: Send + 'static>(
        window: &WebviewWindow,
        work: impl FnOnce() -> T + Send + 'static,
    ) -> Option<T> {
        let (tx, rx) = std::sync::mpsc::channel();
        window
            .run_on_main_thread(move || {
                let _ = tx.send(work());
            })
            .ok()?;
        rx.recv().ok()
    }

    fn ns_window(window: &WebviewWindow) -> Option<Retained<NSWindow>> {
        let handle = window.window_handle().ok()?;
        let RawWindowHandle::AppKit(appkit) = handle.as_raw() else {
            return None;
        };
        let view = appkit.ns_view.as_ptr().cast::<NSView>();
        if view.is_null() {
            return None;
        }
        unsafe { &*view }.window()
    }

    /// Opaque window, painted with the page's own colour.
    ///
    /// The webview covers the whole content view, so this colour only shows for
    /// the frame between the window appearing and the first desktop sample
    /// arriving — which must not be the desktop, or the window would look like
    /// it is sliding over the wallpaper.
    pub fn keep_opaque(window: &WebviewWindow, color: Rgb) {
        let Some(ns_window) = ns_window(window) else {
            return;
        };
        ns_window.setOpaque(true);
        ns_window.setBackgroundColor(Some(&srgb(color)));
        ns_window.setHasShadow(true);
        ns_window.invalidateShadow();
    }

    fn srgb(color: Rgb) -> Retained<NSColor> {
        NSColor::colorWithSRGBRed_green_blue_alpha(
            f64::from(color.r) / 255.0,
            f64::from(color.g) / 255.0,
            f64::from(color.b) / 255.0,
            1.0,
        )
    }

    pub fn window_target(window: &WebviewWindow) -> Result<Target, String> {
        let ns_window = ns_window(window).ok_or_else(|| "取不到窗口".to_string())?;
        let content = ns_window
            .contentView()
            .ok_or_else(|| "窗口没有内容视图".to_string())?;
        // The page sits in the content view, so the sample has to start where
        // the content view starts — with `titleBarStyle: Overlay` that is the
        // window's top edge, but reading it beats assuming it.
        let on_screen = ns_window.convertRectToScreen(content.convertRect_toView(content.bounds(), None));
        let mtm = MainThreadMarker::new().ok_or_else(|| "不在主线程".to_string())?;
        // AppKit's global space has its origin at the bottom left of the *primary*
        // display; CoreGraphics counts down from that display's top edge. It has to
        // be `screens[0]`, not `mainScreen`: `mainScreen` follows keyboard focus, so
        // on a second monitor it would report that display's height and shift the
        // capture by the difference.
        let primary = NSScreen::screens(mtm)
            .firstObject()
            .ok_or_else(|| "取不到主屏".to_string())?;
        let primary_height = primary.frame().size.height;
        let origin = CGPoint::new(
            on_screen.origin.x,
            primary_height - (on_screen.origin.y + on_screen.size.height),
        );
        let size = CGSize::new(on_screen.size.width, on_screen.size.height);
        Ok(Target {
            window_id: ns_window.windowNumber() as u32,
            rect: CGRect::new(origin, size),
        })
    }

    pub fn capture(target: &Target, color: Rgb) -> Result<GlassSample, String> {
        // The same permission the screen channel needs, so a user who granted it
        // once gets glass for free and the other way round reports the same thing.
        if !crate::screen::capture::permission_granted() {
            return Err("屏幕录制权限没有开".into());
        }
        // Nominal (1x) on purpose: this layer *is* the frost, its whole job is to
        // be soft, and a Retina capture would be four times the JPEG, four times
        // the decode, and four times the texture for pixels the blur removes.
        let image = unsafe {
            CGWindowListCreateImage(
                target.rect,
                OPTION_ON_SCREEN_BELOW_WINDOW,
                target.window_id,
                IMAGE_BOUNDS_IGNORE_FRAMING | IMAGE_SHOULD_BE_OPAQUE | IMAGE_NOMINAL_RESOLUTION,
            )
        };
        if image.is_null() {
            return Err("系统没有把桌面交给这个窗口（屏幕录制权限）".into());
        }
        let width = unsafe { CGImageGetWidth(image) };
        let height = unsafe { CGImageGetHeight(image) };
        if width == 0 || height == 0 {
            unsafe { CGImageRelease(image) };
            return Err("桌面取样是空的".into());
        }

        // Opaque fill first: JPEG has no alpha, and anything the capture leaves
        // uncovered has to become the window colour rather than black.
        let row_bytes = width * 4;
        let mut pixels = vec![0u8; row_bytes * height];
        for pixel in pixels.chunks_exact_mut(4) {
            pixel[0] = color.r;
            pixel[1] = color.g;
            pixel[2] = color.b;
            pixel[3] = 255;
        }

        let space = unsafe { CGColorSpaceCreateDeviceRGB() };
        let context = unsafe {
            CGBitmapContextCreate(
                pixels.as_mut_ptr().cast(),
                width,
                height,
                8,
                row_bytes,
                space,
                ALPHA_PREMULTIPLIED_LAST | BITMAP_BYTE_ORDER_32_BIG,
            )
        };
        if context.is_null() {
            unsafe {
                CGImageRelease(image);
                CGColorSpaceRelease(space);
            }
            return Err("建不出位图上下文".into());
        }

        // A bitmap context fills top-down in memory, so the buffer reads as an
        // upright image: no flip needed before encoding.
        unsafe {
            CGContextDrawImage(
                context,
                CGRect::new(
                    CGPoint::new(0.0, 0.0),
                    CGSize::new(width as f64, height as f64),
                ),
                image,
            );
            CGContextRelease(context);
            CGColorSpaceRelease(space);
            CGImageRelease(image);
        }

        let mut rgb = Vec::with_capacity(width * height * 3);
        for pixel in pixels.chunks_exact(4) {
            rgb.extend_from_slice(&pixel[..3]);
        }

        let mut jpeg = Vec::new();
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 74);
        encoder
            .encode(
                &rgb,
                width as u32,
                height as u32,
                image::ExtendedColorType::Rgb8,
            )
            .map_err(|error| format!("桌面取样编码失败：{error}"))?;

        use base64::Engine as _;
        Ok(GlassSample {
            data: base64::engine::general_purpose::STANDARD.encode(&jpeg),
            width: width as u32,
            height: height as u32,
        })
    }
}
