/**
 * `npm run deny <execution-id> [--user <id>] [--json]`: denies an execution
 * left in `awaiting_approval`. Terminal; nothing is issued.
 */
import { decideFromCli } from "./decide.js";

await decideFromCli("deny");
