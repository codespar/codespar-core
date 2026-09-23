/**
 * `npm run deny <execution-id> [--user <id>] [--json]`: denies an execution
 * left in `awaiting_approval`. Terminal; nothing is sent.
 */
import { decideFromCli } from "./decide.js";

await decideFromCli("deny");
