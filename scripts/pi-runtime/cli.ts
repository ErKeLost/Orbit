import { main } from "./index.ts";
import { setupCli } from "../../node_modules/@earendil-works/pi-coding-agent/dist/cli/setup.js";
setupCli();
await main(process.argv.slice(2));
