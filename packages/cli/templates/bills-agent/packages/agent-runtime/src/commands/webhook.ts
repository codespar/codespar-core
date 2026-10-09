/**
 * `codespar-agent webhook [--port <n>] [--secret <trigger secret>]`: starts
 * the receiving end of the webhook channel on localhost. A stub for the
 * developer who has a URL the API can reach; the terminal's default is
 * `codespar-agent poll`. Reads `<PREFIX>_WEBHOOK_PORT` and
 * `<PREFIX>_TRIGGER_SECRET` when the flags are absent.
 */
import { stderr, stdout } from "node:process";
import { envName, type Agent } from "../agent.js";
import { inLocaleOf, localeFlag, setup } from "../setup.js";
import { announceOutcome, followUp } from "../terminal.js";
import { startWebhookServer } from "../webhook.js";

export async function webhook(agent: Agent, argv: string[]): Promise<number> {
  const port = Number(argv.includes("--port") ? argv[argv.indexOf("--port") + 1] : process.env[envName(agent, "WEBHOOK_PORT")] ?? "8787");
  const secret = argv.includes("--secret") ? argv[argv.indexOf("--secret") + 1] : process.env[envName(agent, "TRIGGER_SECRET")];
  const say = (l: string) => stderr.write(l + "\n");
  let locale;
  try {
    locale = localeFlag(argv);
  } catch (err) {
    say(err instanceof Error ? err.message : String(err));
    return 2;
  }
  const s = setup(agent, { say, runId: `run_webhook_${Date.now().toString(36)}`, locale });
  const server = startWebhookServer(
    port,
    {
      engine: s.engine,
      secret,
      onClosed: async (execution) => {
        // Told in the locale of the run that issued the charge, whatever this receiver's own is.
        announceOutcome(execution, inLocaleOf(s, execution), (l) => void stdout.write(l + "\n"));
        await followUp(execution, s, say);
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
  // The receiver runs until a signal stops it.
  return new Promise<number>(() => undefined);
}
