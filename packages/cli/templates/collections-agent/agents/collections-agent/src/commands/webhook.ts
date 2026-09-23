/**
 * `npm run webhook [--port <n>] [--secret <trigger secret>]`: starts the
 * receiving end of `channels/webhook` on localhost. A stub for the
 * developer who has a URL the API can reach; the terminal's default is
 * `npm run poll`. Reads `COLLECTIONS_WEBHOOK_PORT` and
 * `COLLECTIONS_TRIGGER_SECRET` when the flags are absent.
 */
import { stderr, stdout } from "node:process";
import { announceOutcome } from "../../channels/terminal/index.js";
import { startWebhookServer } from "../../channels/webhook/index.js";
import { readDotEnv, setup } from "../setup.js";

const argv = process.argv.slice(2);
readDotEnv();
const port = Number(argv.includes("--port") ? argv[argv.indexOf("--port") + 1] : process.env["COLLECTIONS_WEBHOOK_PORT"] ?? "8787");
const secret = argv.includes("--secret") ? argv[argv.indexOf("--secret") + 1] : process.env["COLLECTIONS_TRIGGER_SECRET"];
const say = (l: string) => stderr.write(l + "\n");
const s = setup({ say, runId: `run_webhook_${Date.now().toString(36)}` });
const server = startWebhookServer(
  port,
  {
    engine: s.engine,
    secret,
    onClosed: (execution) => {
      announceOutcome(execution, s, (l) => stdout.write(l + "\n"));
    },
  },
  say,
);
const stop = () => {
  server.close();
  s.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
