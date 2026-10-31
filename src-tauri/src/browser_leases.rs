//! Stable session/site ownership. Completing a run releases control, never destroys its page.
use std::collections::HashMap;
use std::time::{Duration, Instant};

struct Lease { tab: String, owner: Option<String>, claimed_at: Instant }
#[derive(Default)]
pub(crate) struct BrowserLeases { entries: HashMap<String, Lease>, recent: HashMap<String, String> }
impl BrowserLeases {
    pub(crate) fn has_active(&self) -> bool {
        self.entries.values().any(|lease| lease.owner.is_some() && lease.claimed_at.elapsed() < Duration::from_secs(11 * 60))
    }
    pub(crate) fn claim(&mut self, scope: &str, origin: Option<&str>, preferred: Option<&str>, owner: &str, now: Instant, new_id: impl FnOnce() -> String) -> String {
        let key = origin.map(|origin| format!("{scope}\n{origin}")).or_else(|| self.recent.get(scope).cloned()).unwrap_or_else(|| format!("{scope}\ncurrent"));
        let mut selected_key = key.clone();
        if self.entries.get(&selected_key).is_some_and(|lease| lease.owner.is_some() && now.duration_since(lease.claimed_at) < Duration::from_secs(11 * 60) && lease.owner.as_deref() != Some(owner)) {
            selected_key = format!("{key}\n{owner}");
        }
        let live = |lease: &Lease| lease.owner.is_some() && now.duration_since(lease.claimed_at) < Duration::from_secs(11 * 60);
        if let Some(lease) = self.entries.get_mut(&selected_key) {
            if !live(lease) || lease.owner.as_deref() == Some(owner) {
                lease.owner = Some(owner.to_string()); lease.claimed_at = now;
                let tab = lease.tab.clone(); self.recent.insert(scope.to_string(), selected_key); return tab;
            }
        }
        // A released page still belongs to its original session/site. Creating
        // a second entry for it would let two owners operate the same webview.
        let available = preferred.filter(|tab| !self.entries.values().any(|lease| lease.tab == *tab));
        let tab = available.map(str::to_owned).unwrap_or_else(new_id);
        self.entries.insert(selected_key.clone(), Lease { tab: tab.clone(), owner: Some(owner.into()), claimed_at: now });
        self.recent.insert(scope.to_string(), selected_key);
        tab
    }
    /// Exact targeting never allocates a different tab when the target is busy.
    /// This identity lives in the host, so restarting Pi does not lose its pages.
    pub(crate) fn acquire(&mut self, scope: &str, tab: &str, owner: &str, now: Instant) -> Result<(), String> {
        if owner.is_empty() { return Err("浏览器操作需要 owner".into()); }
        let prefix = format!("{scope}\n");
        let (key, lease) = self.entries.iter_mut().find(|(key, lease)| key.starts_with(&prefix) && lease.tab == tab)
            .ok_or("此页面不属于当前 session，请先使用 browser_open")?;
        if lease.owner.as_deref().is_some_and(|current| current != owner) && now.duration_since(lease.claimed_at) < Duration::from_secs(11 * 60) {
            return Err("此页面正在被另一项操作使用，请稍后重试".into());
        }
        lease.owner = Some(owner.into());
        lease.claimed_at = now;
        self.recent.insert(scope.into(), key.clone());
        Ok(())
    }
    pub(crate) fn tabs(&self, scope: &str) -> Vec<String> {
        let prefix = format!("{scope}\n");
        let mut tabs: Vec<_> = self.entries.iter().filter(|(key, _)| key.starts_with(&prefix)).map(|(_, lease)| lease.tab.clone()).collect();
        tabs.sort();
        tabs
    }
    pub(crate) fn current(&self, scope: &str) -> Option<String> {
        self.recent.get(scope).and_then(|key| self.entries.get(key)).map(|lease| lease.tab.clone())
    }
    pub(crate) fn release_owner(&mut self, scope: &str, owner: &str) -> Vec<String> {
        let prefix = format!("{scope}\n");
        let mut released = Vec::new();
        for (key, lease) in &mut self.entries {
            if key.starts_with(&prefix) && lease.owner.as_deref() == Some(owner) {
                lease.owner = None;
                released.push(lease.tab.clone());
            }
        }
        released
    }
    pub(crate) fn owns(&self, tab: &str, owner: &str) -> bool {
        !owner.is_empty() && self.entries.values().any(|lease| lease.tab == tab && lease.owner.as_deref() == Some(owner))
    }
    pub(crate) fn release(&mut self, tab: &str, owner: &str) -> bool {
        let Some(lease) = self.entries.values_mut().find(|lease| lease.tab == tab && lease.owner.as_deref() == Some(owner)) else { return false; };
        lease.owner = None; true
    }
    pub(crate) fn forget(&mut self, tab: &str) {
        self.entries.retain(|_, lease| lease.tab != tab);
        self.recent.retain(|_, key| self.entries.contains_key(key));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_targets_recover_after_release_and_cross_origin_navigation() {
        let mut leases = BrowserLeases::default(); let now = Instant::now();
        leases.claim("a", Some("https://one.test"), None, "first", now, || "tab-1".into());
        leases.release("tab-1", "first");
        assert!(leases.acquire("a", "tab-1", "second", now).is_ok());
        assert_eq!(leases.tabs("a"), vec!["tab-1"]);
        assert_eq!(leases.current("a").as_deref(), Some("tab-1"));
        assert!(leases.acquire("b", "tab-1", "stranger", now).is_err());
        assert!(leases.acquire("a", "tab-1", "competing", now).is_err());
        assert!(leases.owns("tab-1", "second"));
        leases.forget("tab-1");
        assert!(leases.current("a").is_none());
        assert!(leases.acquire("a", "tab-1", "late", now).is_err());
    }
    #[test]
    fn sequential_work_reuses_its_page_without_following_active_tab() {
        let mut leases = BrowserLeases::default(); let now = Instant::now();
        assert_eq!(leases.claim("session-a", Some("https://one.test"), None, "run-1", now, || "tab-1".into()), "tab-1");
        assert!(leases.release("tab-1", "run-1"));
        assert_eq!(leases.claim("session-a", None, Some("unrelated-active-tab"), "run-2", now, || "tab-2".into()), "tab-1");
    }
    #[test]
    fn sites_sessions_and_concurrent_runs_do_not_steal_pages() {
        let mut leases = BrowserLeases::default(); let now = Instant::now();
        leases.claim("a", Some("https://one.test"), None, "one", now, || "tab-1".into());
        assert_eq!(leases.claim("a", Some("https://two.test"), None, "two", now, || "tab-2".into()), "tab-2");
        assert_eq!(leases.claim("b", Some("https://one.test"), Some("tab-1"), "three", now, || "tab-3".into()), "tab-3");
        assert_eq!(leases.claim("a", Some("https://one.test"), None, "four", now, || "tab-4".into()), "tab-4");
        assert!(leases.owns("tab-1", "one"));
        assert!(leases.owns("tab-4", "four"));
    }
    #[test]
    fn a_late_release_cannot_unlock_a_new_run() {
        let mut leases = BrowserLeases::default(); let now = Instant::now();
        leases.claim("a", None, None, "old", now, || "tab-1".into()); leases.release("tab-1", "old");
        leases.claim("a", None, None, "new", now, || "tab-2".into());
        assert!(!leases.release("tab-1", "old")); assert!(leases.owns("tab-1", "new"));
    }
    #[test]
    fn a_released_page_cannot_be_aliased_by_another_session_or_site() {
        let mut leases = BrowserLeases::default(); let now = Instant::now();
        leases.claim("a", Some("https://one.test"), None, "one", now, || "tab-1".into());
        leases.release("tab-1", "one");
        assert_eq!(leases.claim("b", None, Some("tab-1"), "two", now, || "tab-2".into()), "tab-2");
        assert_eq!(leases.claim("a", Some("https://two.test"), Some("tab-1"), "three", now, || "tab-3".into()), "tab-3");
        assert_eq!(leases.claim("a", Some("https://one.test"), None, "four", now, || "tab-4".into()), "tab-1");
        assert!(!leases.owns("tab-1", "two"));
    }
}
