import { createInterface } from "node:readline/promises";
import { DEFAULT_BASE_URL } from "../did.js";
import { stdin as input, stdout as output } from "node:process";
import { loadConfig, saveConfig, CliError } from "../config.js";
import { ApiClient } from "../api.js";
import { success, info, json } from "../output.js";

interface LoginOptions {
  apiKey?: string;
  baseUrl?: string;
  json?: boolean;
}

const fetchWhoami = (client: ApiClient) => client.get("/v1/whoami");
type Whoami = Awaited<ReturnType<typeof fetchWhoami>>;

/**
 * `/v1/whoami` answers `user: null` for an API key: a key belongs to an org
 * and a project, not to a person. So the credential is named by organization,
 * project and key, and a person is shown only when the API names one. What
 * the body does not carry is left out, never printed as a placeholder. The
 * optional chaining is for a runtime that answers an older, thinner body.
 */
function identity(me: Whoami): {
  email?: string;
  organization?: string;
  project?: string;
  keyId?: string;
  environment?: string;
  scopes?: string[];
} {
  return {
    email: me.user?.email,
    // `||`, not `??`: an empty name is no name, and the id still identifies.
    organization: me.organization?.name || me.organization?.id,
    project: me.project?.name || me.project?.id,
    keyId: me.key?.id,
    environment: me.key?.environment,
    scopes: me.key?.scopes,
  };
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
  const baseUrl = opts.baseUrl ?? (await loadConfig()).baseUrl ?? DEFAULT_BASE_URL;

  // Validate before saving so we don't persist a typo.
  const client = new ApiClient({ apiKey, baseUrl });
  const me = await fetchWhoami(client);

  await saveConfig({ apiKey, baseUrl });

  const who = identity(me);
  if (who.email) {
    success(`Logged in as ${who.email}`);
    if (who.organization) info(`Organization: ${who.organization}`);
  } else {
    success(who.organization ? `Logged in to ${who.organization}` : "Logged in");
  }
  if (who.project) info(`Project: ${who.project}`);
  if (who.keyId) {
    info(`Key: ${who.environment ? `${who.keyId} (${who.environment})` : who.keyId}`);
  } else if (who.environment) {
    info(`Key: (${who.environment} key)`);
  }
  // Com `--json` o script recebe o mesmo documento que `whoami` devolve, mais
  // a base URL que ficou gravada. Antes recebia zero byte no stdout e tinha de
  // ler o `✓` do stderr para saber que deu certo.
  if (opts.json) json({ ...me, base_url: baseUrl });
}

export async function whoamiCommand(client: ApiClient, asJson: boolean): Promise<void> {
  const me = await fetchWhoami(client);

  if (asJson) {
    const { json } = await import("../output.js");
    json(me);
    return;
  }

  const { kv } = await import("../output.js");
  const who = identity(me);
  const rows: Array<[string, string]> = [];
  if (who.email) rows.push(["User", who.email]);
  if (who.organization) rows.push(["Organization", who.organization]);
  if (who.project) rows.push(["Project", who.project]);
  if (who.keyId) rows.push(["Key", who.keyId]);
  if (who.environment) rows.push(["Key env", who.environment]);
  if (who.scopes) rows.push(["Scopes", who.scopes.join(", ") || "(all)"]);
  kv(rows);
}
