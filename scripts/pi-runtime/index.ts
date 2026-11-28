// OAuth flows use variable imports upstream. Embed them explicitly so the
// installed application never depends on a checkout's node_modules.
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
registerBunOAuthFlows();
export * from "@earendil-works/pi-coding-agent";
// Reuse Pi's cache-miss calculation for the GUI transcript notifications.
export { detectCacheMiss } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/cache-stats.js";
