/**
 * Bundled worker entry for the codemode sandbox.
 *
 * Pi's Node bundle builds this as a separate entrypoint because
 * `@earendil-works/pi-codemode`'s own worker file is not on disk in a bundled
 * runtime. `getCodemodeWorkerSpecifier()` (Pi config) resolves the emitted
 * `codemode-worker.js` next to the other runtime chunks, so the output filename
 * must stay `codemode-worker.js`.
 */
import "@earendil-works/pi-codemode/worker";
