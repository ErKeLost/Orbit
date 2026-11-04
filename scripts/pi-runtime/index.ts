// OAuth flows use variable imports upstream. Embed them explicitly so the
// installed application never depends on a checkout's node_modules.
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
registerBunOAuthFlows();
export * from "@earendil-works/pi-coding-agent";
