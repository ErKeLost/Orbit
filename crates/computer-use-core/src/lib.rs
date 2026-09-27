//! Transport-independent observation ledger. A ref is evidence of observation,
//! not authority to mutate by itself. The platform adapter must validate live
//! process/window/element identity before a one-shot action is dispatched.
pub mod transaction;

use rustc_hash::FxHashMap;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObservedTarget {
    pub path: Vec<usize>,
    pub role: String,
    pub name: Option<String>,
    pub stable_id: Option<String>,
    pub actions: Vec<String>,
    pub window_role: String,
    pub window_name: Option<String>,
    pub has_bounds: bool,
}

#[derive(Debug, Default)]
pub struct ObservationLedger {
    generation: Option<String>,
    app: String,
    pid: Option<i64>,
    targets: FxHashMap<String, ObservedTarget>,
    consumed: bool,
}

impl ObservationLedger {
    /// Replaces all prior refs, including on failed or windowless observations.
    pub fn clear(&mut self) {
        *self = Self::default();
    }

    pub fn register(&mut self, snapshot: &Value) -> Result<(), &'static str> {
        self.clear();
        let generation = snapshot["snapshot_id"]
            .as_str()
            .ok_or("missing generation")?;
        let app = snapshot["app"].as_str().ok_or("missing application")?;
        let pid = snapshot["tree"]["pid"]
            .as_i64()
            .ok_or("missing process ID")?;
        let windows = snapshot["tree"]["children"]
            .as_array()
            .ok_or("missing windows")?;
        // A partial observation (a stalled renderer hit the read deadline)
        // still issues refs for every node it actually read; each ref is
        // re-validated against the live element before dispatch.
        if windows.is_empty() {
            return Err("no window observation");
        }
        let mut targets = FxHashMap::default();
        for (window_index, window) in windows.iter().enumerate() {
            let window_role = window["role"].as_str().ok_or("missing window role")?;
            let window_name = window["name"].as_str().map(str::to_owned);
            collect(
                window,
                vec![window_index],
                window_role,
                &window_name,
                &mut targets,
            )?;
        }
        self.targets = targets;
        self.generation = Some(generation.to_owned());
        self.app = app.to_owned();
        self.pid = Some(pid);
        Ok(())
    }

    /// Only accepts a ref actually issued in the latest observation, for the
    /// same application/process. Live window and element comparison is still
    /// required immediately before dispatch.
    pub fn process_id(&self) -> Option<i64> {
        self.pid
    }

    pub fn authorize(
        &self,
        app: &str,
        pid: i64,
        reference: &str,
        action: &str,
    ) -> Result<&ObservedTarget, &'static str> {
        if self.generation.is_none() {
            return Err("no active observation");
        }
        if self.consumed {
            return Err("observation already consumed by an action attempt");
        }
        if self.app != app || self.pid != Some(pid) {
            return Err("process identity changed");
        }
        let target = self
            .targets
            .get(reference)
            .ok_or("stale or unissued AX ref")?;
        let supported = target.actions.iter().any(|candidate| match action {
            "click" | "double-click" => {
                candidate == "activate"
                    || candidate == "press"
                    || candidate == "click"
                    || (candidate == "focus" && target.has_bounds)
            }
            "focus" => candidate == "focus",
            "set-value" => candidate == "set_value" || candidate == "set-value",
            // Keyboard entry into a field that only advertises SetValue is
            // legitimate (Electron/web inputs); the platform layer re-checks.
            "type" => candidate == "type_text" || candidate == "type-text" || candidate == "set_value" || candidate == "set-value",
            "press" => candidate == "press" || candidate == "activate" || candidate == "focus",
            "activate" => candidate == "activate" || candidate == "focus",
            // Scrolling acts on the ancestor container; the target itself only
            // needs geometry so the viewport check is meaningful.
            "scroll-to" => target.has_bounds,
            "scroll-up" => candidate == "scroll_up_by_page" || candidate == "scroll",
            "scroll-down" => candidate == "scroll_down_by_page" || candidate == "scroll",
            "right-click" => candidate == "show_menu",
            "clear" => candidate == "set_value" || candidate == "set-value",
            other => candidate == other,
        });
        if !supported {
            return Err("action not advertised by observed element");
        }
        Ok(target)
    }

    /// Consume before invoking any platform mutation. Even a transport timeout
    /// or ambiguous platform error cannot authorize a replay from this snapshot.
    /// The caller must obtain and register a fresh successor observation.
    pub fn consume_focused(&mut self, app: &str, pid: i64, action: &str) -> Result<(), &'static str> {
        if self.generation.is_none() || self.consumed { return Err("no active observation or observation already consumed"); }
        if self.app != app || self.pid != Some(pid) { return Err("process identity changed"); }
        if action != "press" { return Err("focused action is only supported for press"); }
        self.consumed = true;
        Ok(())
    }

    pub fn consume(
        &mut self,
        app: &str,
        pid: i64,
        reference: &str,
        action: &str,
    ) -> Result<ObservedTarget, &'static str> {
        let target = self.authorize(app, pid, reference, action)?.clone();
        self.consumed = true;
        Ok(target)
    }
}

impl ObservedTarget {
    /// Comparison is performed against a freshly resolved window and element,
    /// never against caller-supplied ref contents.
    pub fn matches_live(
        &self,
        path: &[usize],
        window_role: &str,
        window_name: Option<&str>,
        role: &str,
        name: Option<&str>,
        stable_id: Option<&str>,
        actions: &[String],
    ) -> bool {
        self.path == path
            && self.window_role == window_role
            && self.window_name.as_deref() == window_name
            && self.role == role
            && self.name.as_deref() == name
            && self.stable_id.as_deref() == stable_id
            && self.actions.iter().all(|action| actions.contains(action))
    }
}

fn positive_number(value: &Value) -> bool {
    value.as_f64().is_some_and(|number| number > 0.0)
        || value.as_u64().is_some_and(|number| number > 0)
}

fn collect(
    node: &Value,
    path: Vec<usize>,
    window_role: &str,
    window_name: &Option<String>,
    targets: &mut FxHashMap<String, ObservedTarget>,
) -> Result<(), &'static str> {
    // Placeholders for children that vanished or timed out carry no ref.
    let Some(reference) = node["ref_id"].as_str() else {
        return Ok(());
    };
    let role = node["role"].as_str().ok_or("missing element role")?;
    let actions = node["actions"]
        .as_array()
        .ok_or("missing element actions")?
        .iter()
        .filter_map(|value| value.as_str().map(str::to_owned))
        .collect();
    if targets
        .insert(
            reference.to_owned(),
            ObservedTarget {
                path: path.clone(),
                role: role.to_owned(),
                name: node["name"].as_str().map(str::to_owned),
                stable_id: node["stable_id"].as_str().map(str::to_owned),
                actions,
                window_role: window_role.to_owned(),
                window_name: window_name.clone(),
                has_bounds: positive_number(&node["bounds"]["width"])
                    && positive_number(&node["bounds"]["height"]),
            },
        )
        .is_some()
    {
        return Err("duplicate element ref");
    }
    if let Some(children) = node["children"].as_array() {
        for (index, child) in children.iter().enumerate() {
            let mut child_path = path.clone();
            child_path.push(index);
            collect(child, child_path, window_role, window_name, targets)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn snapshot(generation: &str, reference: &str) -> Value {
        json!({"snapshot_id":generation,"app":"Example","complete":true,"tree":{"pid":42,"children":[
            {"ref_id":"window","role":"window","name":"A","actions":[],"children":[
                {"ref_id":reference,"role":"button","name":"Go","actions":["press"],"children":[]}
            ]}
        ]}})
    }

    #[test]
    fn rejects_unissued_forged_and_old_refs() {
        let mut ledger = ObservationLedger::default();
        ledger.register(&snapshot("one", "first")).unwrap();
        assert_eq!(
            ledger
                .authorize("Example", 42, "first", "press")
                .unwrap()
                .path,
            vec![0, 0]
        );
        assert!(ledger.authorize("Example", 42, "forged", "press").is_err());
        ledger.register(&snapshot("two", "second")).unwrap();
        assert!(ledger.authorize("Example", 42, "first", "press").is_err());
    }

    #[test]
    fn rejects_other_process_capability_and_windowless_observation() {
        let mut ledger = ObservationLedger::default();
        ledger.register(&snapshot("one", "first")).unwrap();
        assert!(ledger.authorize("Other", 42, "first", "press").is_err());
        assert!(ledger.authorize("Example", 43, "first", "press").is_err());
        assert!(ledger
            .authorize("Example", 42, "first", "set_value")
            .is_err());
        assert!(ledger.register(&json!({"snapshot_id":"two","app":"Example","complete":true,"tree":{"pid":42,"children":[]}})).is_err());
        assert!(ledger.authorize("Example", 42, "first", "press").is_err());
    }

    #[test]
    fn authorizes_context_menu_and_clear_only_from_matching_ax_capabilities() {
        let mut ledger = ObservationLedger::default();
        let value = json!({
            "snapshot_id": "menu-clear",
            "app": "Example",
            "complete": true,
            "tree": {"pid": 42, "children": [{"ref_id": "window", "role": "window", "name": "A", "actions": [], "children": [
                {"ref_id": "menu", "role": "button", "name": "More", "actions": ["show_menu"], "children": []},
                {"ref_id": "field", "role": "text_field", "name": "Search", "actions": ["set_value"], "children": []}
            ]}]}
        });
        ledger.register(&value).unwrap();
        assert!(ledger.authorize("Example", 42, "menu", "right-click").is_ok());
        assert!(ledger.authorize("Example", 42, "field", "clear").is_ok());
        assert!(ledger.authorize("Example", 42, "field", "right-click").is_err());
        assert!(ledger.authorize("Example", 42, "menu", "clear").is_err());
    }

    #[test]
    fn consuming_a_ref_prevents_replay_even_if_delivery_is_uncertain() {
        let mut ledger = ObservationLedger::default();
        ledger.register(&snapshot("one", "first")).unwrap();
        let target = ledger.consume("Example", 42, "first", "press").unwrap();
        assert!(target.matches_live(
            &[0, 0],
            "window",
            Some("A"),
            "button",
            Some("Go"),
            None,
            &["press".into()]
        ));
        assert!(!target.matches_live(
            &[0, 0],
            "window",
            Some("Other"),
            "button",
            Some("Go"),
            None,
            &["press".into()]
        ));
        assert!(!target.matches_live(
            &[0, 0],
            "window",
            Some("A"),
            "button",
            Some("Other"),
            None,
            &["press".into()]
        ));
        assert!(!target.matches_live(
            &[0, 1],
            "window",
            Some("A"),
            "button",
            Some("Go"),
            None,
            &["press".into()]
        ));
        assert!(ledger.consume("Example", 42, "first", "press").is_err());
        ledger.register(&snapshot("two", "second")).unwrap();
        assert!(ledger.consume("Example", 42, "second", "press").is_ok());
    }

    #[test]
    fn accepts_only_issued_refs_from_partial_observation_and_rejects_duplicates() {
        let mut ledger = ObservationLedger::default();
        let mut incomplete = snapshot("one", "first");
        incomplete["complete"] = json!(false);
        incomplete["tree"]["children"][0]["children"]
            .as_array_mut().unwrap().push(json!({"role":"unknown"}));
        ledger.register(&incomplete).unwrap();
        assert!(ledger.authorize("Example", 42, "first", "press").is_ok());
        assert!(ledger.authorize("Example", 42, "unissued", "press").is_err());
        assert!(ledger.register(&snapshot("one", "window")).is_err());
    }
}
