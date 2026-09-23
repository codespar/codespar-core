// A stand-in for a kit agent's entry: echoes what it received, in the two
// output modes the real one has, and answers the exit codes it answers.
const [command, ...argv] = process.argv.slice(2);
const json = argv.includes("--json");
const input = argv.includes("--input") ? argv[argv.indexOf("--input") + 1] : undefined;

if (command === "start") {
  process.stderr.write(`[kit] start ${argv.join(" ")}\n`);
  const doc = { agent: "kit-under-test@0.0.1", argv, input: input ?? null, reply: `echo: ${input ?? "(interactive)"}` };
  if (json) process.stdout.write(JSON.stringify(doc) + "\n");
  else process.stdout.write(doc.reply + "\n");
  process.exit(input === "leave one in flight" ? 3 : 0);
}

if (command === "check") {
  const ok = process.env.KIT_CHECK_FAIL !== "1";
  const doc = ok
    ? { ok: true, agent: "kit-under-test", findings: [{ level: "warning", code: "just_a_warning", message: "does not fail the check" }] }
    : { ok: false, agent: "kit-under-test", findings: [{ level: "error", code: "tools_contradict_manifest", message: "tools.json disagrees" }] };
  process.stderr.write(`[kit] check ${ok ? "ok" : "FAILED"}\n`);
  if (json) process.stdout.write(JSON.stringify(doc) + "\n");
  process.exit(ok ? 0 : 1);
}

if (command === "eval") {
  const fail = process.env.KIT_EVAL_FAIL === "1";
  const doc = {
    ok: !fail,
    adversarial: [
      { name: "beneficiary-swap", attack: "Troca de favorecido", ok: true, failures: [], states: ["denied"] },
      { name: "exfiltration", attack: "Exfiltracao", ok: !fail, failures: fail ? ["codespar_wallet was called"] : [], states: [] },
    ],
    scenarios: [
      { name: "happy-path", mode: "human", ok: true, failures: [], states: ["awaiting_approval"], receipts: 0 },
      { name: "happy-path", mode: "mandate", ok: true, failures: [], states: ["settled"], receipts: 1 },
    ],
  };
  process.stderr.write(`[kit] eval ${fail ? "FAILED" : "ok"}\n`);
  if (json) process.stdout.write(JSON.stringify(doc) + "\n");
  process.exit(fail ? 1 : 0);
}

process.stderr.write(`kit.mjs: unknown command ${command}\n`);
process.exit(2);
