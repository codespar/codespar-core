/**
 * `npm run approve <execution-id> [--user <id>] [--json]`: decides an
 * execution left in `awaiting_approval` (a `--input` run without
 * `--approve`, a restart). Produces the section 4.2 artifact and runs the
 * execution through the same last gate `npm start` uses.
 */
import { decideFromCli } from "./decide.js";

await decideFromCli("approve");
