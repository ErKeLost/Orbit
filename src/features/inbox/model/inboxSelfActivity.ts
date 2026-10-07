/**
 * Inbox self-activity telemetry is an Orbit inbox feature; the source-control
 * surface only fires it. Kept as a quiet sink until the inbox port lands.
 */
export function recordInboxSelfActivity(target: unknown, now = Date.now()) {
  void target;
  void now;
}
