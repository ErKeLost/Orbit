//! Window glass, the way MonoCode does it: the system blurs the desktop behind a
//! non-opaque window, and the page paints nothing but a wash on top.
//!
//! This is the wry/WKWebView build (`--features glass-wry`). It is the only
//! desktop runtime whose *page* can be see-through: wry turns `transparent:
//! true` into "the window is not opaque **and** the webview paints no
//! background", so clearing `html`/`body`/`#root` really does reveal what sits
//! under the page. Chromium (CEF, windowed) always fills its view — that build
//! samples the desktop instead; see `window_glass.rs`.

use serde::{Deserialize, Serialize};
use tauri::WebviewWindow;

#[derive(Clone, Copy, Deserialize)]
pub struct Rgb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

/// Present so both builds expose the same command; this one never samples.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlassSample {
    pub data: String,
    pub width: u32,
    pub height: u32,
}

/// `true` when this process painted the shared tint, so the page can stop
/// painting the same wash again.
#[tauri::command]
pub fn set_window_glass_enabled(
    window: WebviewWindow,
    enabled: bool,
    background: Rgb,
    opacity: Option<f64>,
) -> bool {
    #[cfg(target_os = "macos")]
    {
        // MonoCode's two lines, verbatim: a hair of alpha keeps the window
        // shadow from going square, and the vibrancy view under the page does
        // the rest. `macos::set_enabled` replaces this colour again.
        let _ = window.set_background_color(Some(tauri::window::Color(0, 0, 0, 3)));
        return macos::set_enabled(&window, enabled, background, opacity);
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
        let _ = opacity;
        false
    }
}

/// Gaussian radius of the desktop behind the window. `0` is no frost.
#[tauri::command]
pub fn set_window_background_blur(window: WebviewWindow, radius: u32) {
    #[cfg(target_os = "macos")]
    macos::set_blur(&window, radius.min(64) as u8);
    #[cfg(not(target_os = "macos"))]
    let _ = (window, radius);
}

/// `None` means "this build has no sampling": the page itself is see-through
/// here, so the desktop does not have to be painted into it.
#[tauri::command]
pub async fn glass_desktop_sample() -> Result<Option<GlassSample>, String> {
    Ok(None)
}

#[cfg(target_os = "macos")]
mod macos {
    use super::Rgb;
    use std::cell::Cell;
    use std::collections::HashSet;
    use std::ffi::{c_char, c_int, c_void};
    use std::sync::atomic::{AtomicU8, Ordering};
    use std::sync::{Mutex, OnceLock};

    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{define_class, msg_send, DefinedClass, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{
        NSAutoresizingMaskOptions, NSColor, NSUserInterfaceItemIdentification, NSView,
        NSVisualEffectBlendingMode, NSVisualEffectMaterial, NSVisualEffectState, NSVisualEffectView,
        NSWindow, NSWindowOrderingMode,
    };
    use objc2_foundation::{NSArray, NSNumber, NSString};
    use objc2_quartz_core::CALayer;
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use tauri::WebviewWindow;

    const BACKING_ID: &str = "orbit.glass-backing";
    const TINT_ID: &str = "orbit.glass-tint";
    const BLUR_MAX: u8 = 64;

    static BLUR_RADIUS: AtomicU8 = AtomicU8::new(0);
    static GLASS_WINDOWS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

    type CgsConnection = usize;
    type SetBlurFn = unsafe extern "C" fn(CgsConnection, c_int, c_int) -> c_int;
    type ConnectionFn = unsafe extern "C" fn() -> CgsConnection;

    unsafe extern "C" {
        fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
    }

    const RTLD_DEFAULT: *mut c_void = -2isize as *mut c_void;


    pub fn set_enabled(window: &WebviewWindow, enabled: bool, background: Rgb, opacity: Option<f64>) -> bool {
        let label = window.label().to_string();
        let window = window.clone();
        let hopped = window.clone();
        let result = on_main(&window, move || apply(hopped, enabled, background, opacity, label));
        result.unwrap_or(false)
    }

    pub fn set_blur(window: &WebviewWindow, radius: u8) {
        let radius = radius.min(BLUR_MAX);
        BLUR_RADIUS.store(radius, Ordering::Relaxed);
        let window = window.clone();
        let hopped = window.clone();
        let _ = on_main(&window, move || {
            if glass_enabled(&hopped) {
                apply_blur(&hopped, radius);
            }
        });
    }

    fn apply(window: WebviewWindow, enabled: bool, background: Rgb, opacity: Option<f64>, label: String) -> bool {
        let Some(ns_window) = ns_window(&window) else {
            set_glass_enabled(&label, false);
            return false;
        };
        if !enabled {
            set_glass_enabled(&label, false);
            hide_glass(&ns_window);
            apply_blur(&window, 0);
            ns_window.setOpaque(true);
            ns_window.setBackgroundColor(Some(&srgb(background, 1.0)));
            ns_window.setHasShadow(true);
            ns_window.invalidateShadow();
            return false;
        }

        set_glass_enabled(&label, true);
        install_glass(&ns_window);
        ns_window.setOpaque(false);
        ns_window.setHasShadow(true);
        ns_window.invalidateShadow();
        // MonoCode's split: with an opacity the *window* carries the tint (the
        // vibrancy material is translucent, so the colour reads through it) and
        // the shared tint view stays clear. Without one, the tint view carries
        // it and the page keeps painting its own wash.
        match opacity.filter(|value| value.is_finite()) {
            Some(opacity) => {
                paint_tint(&ns_window, &NSColor::clearColor());
                ns_window.setBackgroundColor(Some(&srgb(background, opacity.clamp(0.15, 1.0))));
            }
            None => {
                paint_tint(&ns_window, &srgb(background, 0.85));
                ns_window.setBackgroundColor(Some(&NSColor::clearColor().colorWithAlphaComponent(0.01)));
            }
        }
        apply_blur(&window, BLUR_RADIUS.load(Ordering::Relaxed));
        true
    }


    fn on_main<T: Send + 'static>(window: &WebviewWindow, f: impl FnOnce() -> T + Send + 'static) -> Option<T> {
        let (tx, rx) = std::sync::mpsc::channel();
        window.run_on_main_thread(move || {
            let _ = tx.send(f());
        }).ok()?;
        rx.recv().ok()
    }

    fn glass_windows() -> &'static Mutex<HashSet<String>> {
        GLASS_WINDOWS.get_or_init(|| Mutex::new(HashSet::new()))
    }

    fn set_glass_enabled(label: &str, enabled: bool) {
        let mut windows = glass_windows().lock().unwrap_or_else(|err| err.into_inner());
        if enabled {
            windows.insert(label.to_string());
        } else {
            windows.remove(label);
        }
    }

    fn glass_enabled(window: &WebviewWindow) -> bool {
        glass_windows()
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .contains(window.label())
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

    fn srgb(color: Rgb, alpha: f64) -> Retained<NSColor> {
        NSColor::colorWithSRGBRed_green_blue_alpha(
            color.r as f64 / 255.0,
            color.g as f64 / 255.0,
            color.b as f64 / 255.0,
            alpha.clamp(0.0, 1.0),
        )
    }

    fn identified<'a>(content: &'a NSView, id: &str) -> Option<Retained<NSView>> {
        let marker = NSString::from_str(id);
        content.subviews().iter().find(|view| view.identifier().as_deref() == Some(&marker))
    }

    fn install_glass(window: &NSWindow) {
        let Some(content) = window.contentView() else {
            return;
        };
        if identified(&content, BACKING_ID).is_some() {
            if let Some(backing) = identified(&content, BACKING_ID) {
                backing.setHidden(false);
            }
            if let Some(tint) = identified(&content, TINT_ID) {
                tint.setHidden(false);
            }
            return;
        }
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let backing = WindowBackdrop::new(content.bounds(), mtm);
        backing.setIdentifier(Some(&NSString::from_str(BACKING_ID)));
        backing.setAutoresizingMask(
            NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable,
        );
        content.addSubview_positioned_relativeTo(&backing, NSWindowOrderingMode::Below, None);

        let tint = NSView::initWithFrame(NSView::alloc(mtm), content.bounds());
        tint.setIdentifier(Some(&NSString::from_str(TINT_ID)));
        tint.setWantsLayer(true);
        tint.setAutoresizingMask(
            NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable,
        );
        content.addSubview_positioned_relativeTo(&tint, NSWindowOrderingMode::Above, Some(&backing));
    }

    fn hide_glass(window: &NSWindow) {
        let Some(content) = window.contentView() else {
            return;
        };
        if let Some(backing) = identified(&content, BACKING_ID) {
            backing.setHidden(true);
        }
        if let Some(tint) = identified(&content, TINT_ID) {
            tint.setHidden(true);
        }
    }

    fn paint_tint(window: &NSWindow, color: &NSColor) {
        let Some(content) = window.contentView() else {
            return;
        };
        let Some(tint) = identified(&content, TINT_ID) else {
            return;
        };
        tint.setHidden(false);
        if let Some(layer) = tint.layer() {
            layer.setOpaque(false);
            layer.setBackgroundColor(Some(&color.CGColor()));
        }
    }

    fn apply_blur(window: &WebviewWindow, radius: u8) {
        let Some(ns_window) = ns_window(window) else {
            return;
        };
        let Some(content) = ns_window.contentView() else {
            return;
        };
        let patched = identified(&content, BACKING_ID).and_then(|view| {
            let backdrop = view.downcast_ref::<WindowBackdrop>()?;
            backdrop.setHidden(radius == 0);
            Some(backdrop.set_radius(radius))
        });
        // Two blurs stack. The backdrop owns the radius when it accepted one;
        // otherwise the WindowServer blur is the slider.
        let legacy = if patched == Some(true) { 0 } else { radius };
        set_cgs_blur(&ns_window, legacy);
    }

    fn set_cgs_blur(window: &NSWindow, radius: u8) {
        let Some(set_blur) = set_blur_fn() else {
            return;
        };
        let Some(connection) = cgs_connection() else {
            return;
        };
        let number = window.windowNumber();
        if number <= 0 {
            return;
        }
        unsafe {
            set_blur(connection, number as c_int, radius as c_int);
        }
    }

    fn set_blur_fn() -> Option<SetBlurFn> {
        static FN: OnceLock<Option<SetBlurFn>> = OnceLock::new();
        *FN.get_or_init(|| dlsym_fn(b"CGSSetWindowBackgroundBlurRadius\0"))
    }

    fn cgs_connection() -> Option<CgsConnection> {
        static FN: OnceLock<Option<ConnectionFn>> = OnceLock::new();
        let function = (*FN.get_or_init(|| {
            dlsym_fn(b"CGSDefaultConnectionForThread\0").or_else(|| dlsym_fn(b"CGSMainConnectionID\0"))
        }))?;
        let connection = unsafe { function() };
        (connection != 0).then_some(connection)
    }

    fn dlsym_fn<T>(symbol: &[u8]) -> Option<T> {
        unsafe {
            let ptr = dlsym(RTLD_DEFAULT, symbol.as_ptr().cast());
            if ptr.is_null() {
                None
            } else {
                Some(std::mem::transmute_copy(&ptr))
            }
        }
    }

    struct WindowBackdropIvars {
        radius: Cell<u8>,
    }

    define_class!(
        #[unsafe(super(NSVisualEffectView))]
        #[name = "OrbitWindowBackdrop"]
        #[ivars = WindowBackdropIvars]
        struct WindowBackdrop;

        impl WindowBackdrop {
            #[unsafe(method(updateLayer))]
            fn update_layer(&self) {
                unsafe {
                    let _: () = msg_send![super(self), updateLayer];
                }
                self.configure_layers();
            }
        }
    );

    impl WindowBackdrop {
        fn new(frame: objc2_foundation::NSRect, mtm: MainThreadMarker) -> Retained<Self> {
            let allocated = Self::alloc(mtm).set_ivars(WindowBackdropIvars {
                radius: Cell::new(BLUR_RADIUS.load(Ordering::Relaxed)),
            });
            let view: Retained<Self> = unsafe { msg_send![super(allocated), initWithFrame: frame] };
            view.setMaterial(NSVisualEffectMaterial::UnderWindowBackground);
            view.setBlendingMode(NSVisualEffectBlendingMode::BehindWindow);
            view.setState(NSVisualEffectState::Active);
            view.setWantsLayer(true);
            view
        }

        /// `true` when a blur filter actually took the radius.
        fn set_radius(&self, radius: u8) -> bool {
            self.ivars().radius.set(radius);
            let patched = self.configure_layers();
            self.setNeedsDisplay(true);
            patched
        }

        fn configure_layers(&self) -> bool {
            let Some(layer) = self.layer() else {
                return false;
            };
            let configured = objc2::exception::catch(std::panic::AssertUnwindSafe(|| {
                configure_backdrop_layer(&layer, self.ivars().radius.get())
            }));
            configured.unwrap_or(false)
        }
    }

    /// AppKit's material blur ignores the slider until its private Gaussian
    /// filter is replaced. Same approach as MonoCode: drop the saturation
    /// filter (our tint is the colour) and install a copied blur at our radius.
    fn configure_backdrop_layer(layer: &CALayer, radius: u8) -> bool {
        layer.setBackgroundColor(None);
        let mut patched = false;
        if layer.class().name().to_bytes() == b"CAChameleonLayer" {
            layer.setHidden(true);
        } else if let Some(filters) = layer.filters() {
            let mut retained = Vec::with_capacity(filters.len());
            let mut changed = false;
            for filter in filters.iter() {
                let description: Retained<NSString> = unsafe { msg_send![&*filter, description] };
                let description = description.to_string();
                if description.contains("Saturat") {
                    changed = true;
                    continue;
                }
                if description.contains("Blur") {
                    let key = NSString::from_str("inputRadius");
                    let current: Option<Retained<NSNumber>> = unsafe { msg_send![&*filter, valueForKey: &*key] };
                    patched = true;
                    if current.as_ref().map(|value| value.doubleValue()) != Some(f64::from(radius)) {
                        let replacement: Retained<AnyObject> = unsafe { msg_send![&*filter, copy] };
                        let value = NSNumber::numberWithDouble(f64::from(radius));
                        unsafe {
                            let _: () = msg_send![&*replacement, setValue: &*value, forKey: &*key];
                        }
                        retained.push(replacement);
                        changed = true;
                        continue;
                    }
                }
                retained.push(filter);
            }
            if changed {
                unsafe {
                    layer.setFilters(Some(&NSArray::from_retained_slice(&retained)));
                }
            }
        }
        if let Some(children) = unsafe { layer.sublayers() } {
            for child in children.iter() {
                if configure_backdrop_layer(&child, radius) {
                    patched = true;
                }
            }
        }
        patched
    }
}
