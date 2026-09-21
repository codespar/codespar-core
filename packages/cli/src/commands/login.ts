import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadConfig, saveConfig, CliError } from "../config.js";
import { ApiClient } from "../api.js";
import { success, info } from "../output.js";

interface LoginOptions {
  apiKey?: string;
  baseUrl?: string;
}

/**
 * Read a secret from the TTY without echoing it. The API key is a
 * credential — echoing it leaves the key in terminal scrollback and any
 * screen-share. Overrides readline's `_writeToOutput` to show the prompt
 * once and swallow the echoed keystrokes (the standard dependency-free
 * Node password-prompt technique). On non-TTY input (a piped key) there is
 * no echo to suppress, so we read plainly.
 */
async function promptSecret(promptText: string): Promise<string> {
  const rl = createInterface({ input, output });
  if (output.isTTY) {
    const rlAny = rl as unknown as { _writeToOutput?: (s: string) => void };
    let shownPrompt = false;
    rlAny._writeToOutput = (s: string): void => {
      void s;
      if (!shownPrompt) {
        output.write(promptText);
        shownPrompt = true;
      }
      // Everything after the prompt is the echoed secret — swallow it.
    };
  }
  try {
    return await rl.question(promptText);
  } finally {
    if (output.isTTY) output.write("\n");
    rl.close();
  }
}

/**
 * Store an API key on disk. If `--api-key` is passed we use it directly;
 * otherwise we prompt the user interactively. After saving we call
 * /v1/whoami to validate that the key actually works — fail-fast is
 * friendlier than saving a bad key and failing on the next command.
 */
export async function loginCommand(opts: LoginOptions): Promise<void> {
  let apiKey = opts.apiKey;

  if (!apiKey) {
    // Sem TTY a promessa do readline nunca resolve, o processo fica sem
    // trabalho pendente e o Node sai 0: o passo de CI fica verde e o comando
    // seguinte diz "Not logged in". Recusar aqui e a unica saida honesta.
    if (!input.isTTY) {
      throw new CliError(
        "No terminal to prompt on. Pass `--api-key <key>`, or set CODESPAR_API_KEY and skip login.",
      );
    }
    info("Get your API key at https://codespar.dev/dashboard/settings?tab=api-keys");
    apiKey = (await promptSecret("API key: ")).trim();
  }

  if (!apiKey) throw new CliError("API key is required.");
  if (!apiKey.startsWith("csk_")) {
    throw new CliError(
      "That doesn't look like a CodeSpar key — they start with `csk_live_` or `csk_test_`.",
    );
  }

  // Pela mesma cadeia de todo mundo (flag > env > arquivo > padrao), que e o
  // que `loadConfig()` ja faz. Lendo so a env, o `login` pulava o arquivo que
  // ELE MESMO grava: depois de `login --base-url <staging>`, um `login` seco
  // validava a chave contra producao.
  const baseUrl = opts.baseUrl ?? (await loadConfig()).baseUrl ?? "https://api.codespar.dev";

  // Validate before saving so we don't persist a typo.
  const client = new ApiClient({ apiKey, baseUrl });
  const me = await client.get("/v1/whoami");

  await saveConfig({ apiKey, baseUrl });

  success(`Logged in as ${me.user?.email ?? "unknown user"}`);
  if (me.organization?.name) {
    info(`Organization: ${me.organization.name}`);
  }
}

export async function whoamiCommand(client: ApiClient, asJson: boolean): Promise<void> {
  const me = await client.get("/v1/whoami");

  if (asJson) {
    const { json } = await import("../output.js");
    json(me);
    return;
  }

  const { kv } = await import("../output.js");
  kv([
    ["User", me.user?.email ?? "(unknown)"],
    ["Organization", me.organization.name ?? "(none)"],
    ["Project", me.project.name ?? me.project.id],
    ["Key env", me.key.environment ?? "(unknown)"],
    ["Scopes", me.key.scopes.join(", ") || "(all)"],
  ]);
}
