//! Mobile input events applied through the same `xa11y` injection path that
//! `gui_task` uses, which is why both share one accessibility grant.
//!
//! Coordinates arrive normalized to the captured display (`0..1`, top-left
//! origin) so the phone never needs to know about Retina scaling, display
//! arrangement, or the preview resolution. Everything below the normalized
//! boundary is logical screen points.

use serde::Deserialize;

use super::capture::DisplayInfo;

/// One input event from the phone.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ScreenInput {
    Pointer {
        phase: PointerPhase,
        x: f64,
        y: f64,
        #[serde(default)]
        button: Option<String>,
        /// Number of clicks for a `down`/`up` pair; `2` produces a double click.
        #[serde(default)]
        clicks: Option<u32>,
    },
    Scroll {
        x: f64,
        y: f64,
        dx: i32,
        dy: i32,
    },
    /// A named key or chord such as `escape`, `f5`, or `meta+space`.
    Key { key: String },
    /// Literal text; supports non-ASCII and emoji.
    Text { value: String },
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PointerPhase {
    Down,
    Move,
    Up,
}

/// Apply one event to the desktop.
pub fn apply(event: &ScreenInput, display: &DisplayInfo) -> Result<(), String> {
    imp::apply(event, display)
}

/// Map a normalized point onto the captured display's logical geometry.
#[must_use]
pub fn logical_point(display: &DisplayInfo, x: f64, y: f64) -> (f64, f64) {
    let (x, y) = display.to_logical_point(x, y);
    (x.round(), y.round())
}

#[cfg(target_os = "macos")]
mod imp {
    use std::sync::OnceLock;

    use xa11y::{InputSim, Key, MouseButton, Point, ScrollDelta};

    use super::{PointerPhase, ScreenInput, logical_point};
    use crate::screen::capture::DisplayInfo;

    /// The injection backend is process-wide and cheap to reuse; building one
    /// per event would re-run platform setup on every drag sample.
    fn input() -> Result<&'static InputSim, String> {
        static INPUT: OnceLock<Result<InputSim, String>> = OnceLock::new();
        INPUT
            .get_or_init(|| xa11y::input_sim().map_err(|error| error.to_string()))
            .as_ref()
            .map_err(Clone::clone)
    }

    pub(super) fn apply(event: &ScreenInput, display: &DisplayInfo) -> Result<(), String> {
        let input = input()?;
        match event {
            ScreenInput::Pointer {
                phase,
                x,
                y,
                button,
                clicks,
            } => {
                let point = to_point(display, *x, *y);
                let button = match button.as_deref() {
                    Some("right") => MouseButton::Right,
                    Some("middle") => MouseButton::Middle,
                    _ => MouseButton::Left,
                };
                let click_count = clicks.unwrap_or(1).clamp(1, 3);
                // Moving first is what makes dragging work: the pointer has to
                // be at the press point before the button goes down, and stay
                // where the finger left it before the button comes up.
                input
                    .mouse()
                    .move_to(point)
                    .map_err(|error| error.to_string())?;
                match phase {
                    PointerPhase::Move => Ok(()),
                    PointerPhase::Down => (0..click_count).try_for_each(|_| {
                        input.mouse().down(button).map_err(|error| error.to_string())
                    }),
                    PointerPhase::Up => (0..click_count).try_for_each(|_| {
                        input.mouse().up(button).map_err(|error| error.to_string())
                    }),
                }
            }
            ScreenInput::Scroll { x, y, dx, dy } => input
                .mouse()
                .scroll(to_point(display, *x, *y), ScrollDelta::new(*dx, *dy))
                .map_err(|error| error.to_string()),
            ScreenInput::Key { key } => apply_key(&key.to_ascii_lowercase()),
            ScreenInput::Text { value } => input
                .keyboard()
                .type_text(value)
                .map_err(|error| error.to_string()),
        }
    }

    fn to_point(display: &DisplayInfo, x: f64, y: f64) -> Point {
        let (x, y) = logical_point(display, x, y);
        Point::new(x as i32, y as i32)
    }

    /// Resolve `meta+space` style chords, and single keys, onto `xa11y`'s `Key`.
    fn apply_key(spec: &str) -> Result<(), String> {
        let input = input()?;
        let mut parts = spec.split('+').filter(|part| !part.is_empty()).peekable();
        let mut held = Vec::new();
        let mut last = None;
        while let Some(part) = parts.next() {
            let key = named_key(part).ok_or_else(|| format!("不支持的按键：{part}"))?;
            if parts.peek().is_some() {
                if !matches!(key, Key::Shift | Key::Ctrl | Key::Alt | Key::Meta) {
                    return Err(format!("{part} 不能作为组合键的修饰键"));
                }
                held.push(key);
            } else {
                last = Some(key);
            }
        }
        let Some(key) = last else {
            // A lone modifier ("shift") is a press of that modifier.
            return match held.first() {
                Some(key) => input
                    .keyboard()
                    .press(key.clone())
                    .map_err(|error| error.to_string()),
                None => Err("按键为空".into()),
            };
        };
        if held.is_empty() {
            return input
                .keyboard()
                .press(key)
                .map_err(|error| error.to_string());
        }
        input
            .keyboard()
            .chord(key, &held)
            .map_err(|error| error.to_string())
    }

    pub(super) fn named_key(name: &str) -> Option<Key> {
        Some(match name {
            "meta" | "cmd" | "command" | "super" => Key::Meta,
            "ctrl" | "control" => Key::Ctrl,
            "alt" | "option" => Key::Alt,
            "shift" => Key::Shift,
            "enter" | "return" => Key::Enter,
            "escape" | "esc" => Key::Escape,
            "backspace" => Key::Backspace,
            "tab" => Key::Tab,
            "space" => Key::Space,
            "delete" | "del" => Key::Delete,
            "insert" => Key::Insert,
            "up" | "arrowup" => Key::ArrowUp,
            "down" | "arrowdown" => Key::ArrowDown,
            "left" | "arrowleft" => Key::ArrowLeft,
            "right" | "arrowright" => Key::ArrowRight,
            "home" => Key::Home,
            "end" => Key::End,
            "pageup" => Key::PageUp,
            "pagedown" => Key::PageDown,
            other => {
                if let Some(number) = other.strip_prefix('f') {
                    if let Ok(number) = number.parse::<u8>() {
                        if (1..=20).contains(&number) {
                            return Some(Key::F(number));
                        }
                    }
                }
                let mut characters = other.chars();
                let character = characters.next()?;
                if characters.next().is_some() {
                    return None;
                }
                // `xa11y` rejects uppercase `Char` input; the mobile keyboard
                // sends shifted characters through `Text` instead.
                Key::Char(character.to_ascii_lowercase())
            }
        })
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::ScreenInput;
    use crate::screen::capture::DisplayInfo;

    pub(super) fn apply(_event: &ScreenInput, _display: &DisplayInfo) -> Result<(), String> {
        Err("此平台尚未实现屏幕输入注入".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(super) fn display() -> DisplayInfo {
        DisplayInfo {
            id: 1,
            name: "t".into(),
            // A secondary display in the macOS arrangement: non-zero origin.
            logical_x: -1728.0,
            logical_y: 200.0,
            logical_width: 1728.0,
            logical_height: 1117.0,
            pixel_width: 3456,
            pixel_height: 2234,
            scale: 2.0,
            primary: false,
        }
    }

    #[test]
    fn normalized_points_map_onto_a_secondary_display() {
        assert_eq!(logical_point(&display(), 0.0, 0.0), (-1728.0, 200.0));
        assert_eq!(logical_point(&display(), 1.0, 1.0), (0.0, 1317.0));
        // 200 + 1117 * 0.5 = 758.5, rounded away from zero.
        assert_eq!(logical_point(&display(), 0.5, 0.5), (-864.0, 759.0));
    }

    #[test]
    fn out_of_range_points_are_clamped() {
        assert_eq!(logical_point(&display(), 1.5, -0.5), (0.0, 200.0));
    }

    #[test]
    fn input_events_deserialize_from_the_wire_shape() {
        let event: ScreenInput =
            serde_json::from_str(r#"{"kind":"pointer","phase":"down","x":0.25,"y":0.75}"#).unwrap();
        assert!(matches!(
            event,
            ScreenInput::Pointer {
                phase: PointerPhase::Down,
                ..
            }
        ));
        let event: ScreenInput =
            serde_json::from_str(r#"{"kind":"key","key":"meta+space"}"#).unwrap();
        assert!(matches!(event, ScreenInput::Key { .. }));
        let event: ScreenInput =
            serde_json::from_str(r#"{"kind":"text","value":"你好"}"#).unwrap();
        assert!(matches!(event, ScreenInput::Text { .. }));
        let event: ScreenInput =
            serde_json::from_str(r#"{"kind":"scroll","x":0.5,"y":0.5,"dx":0,"dy":-3}"#).unwrap();
        assert!(matches!(event, ScreenInput::Scroll { .. }));
    }
}

#[cfg(all(test, target_os = "macos"))]
mod macos_tests {
    use super::imp::{apply, named_key};
    use xa11y::Key;

    #[test]
    fn named_keys_and_chords_resolve() {
        assert_eq!(named_key("escape"), Some(Key::Escape));
        assert_eq!(named_key("arrowup"), Some(Key::ArrowUp));
        assert_eq!(named_key("f11"), Some(Key::F(11)));
        assert_eq!(named_key("a"), Some(Key::Char('a')));
        assert_eq!(named_key("A"), Some(Key::Char('a')));
        assert_eq!(named_key("nonsense"), None);
    }

    fn apply_key(spec: &str) -> Result<(), String> {
        // `apply_key` is private to the backend; exercise it through the same
        // path the wire uses.
        apply(
            &super::ScreenInput::Key { key: spec.into() },
            &super::tests::display(),
        )
    }

    #[test]
    fn malformed_chords_are_rejected_before_injection() {
        // `escape` cannot hold `a`; this has to fail before touching the OS.
        assert!(apply_key("escape+a").is_err());
        assert!(apply_key("meta+nosuchkey").is_err());
    }
}
