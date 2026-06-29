// Demo plugin for the boleto-expiry fiscal-remediation example.
//
// Registers `codespar_invoice`, `codespar_notify`, and `codespar_pay` as
// meta-tools on the runtime via the MetaToolHook seam, using the shared
// definitions published from @codespar/types. The payment-status read and the
// NF-e status/amend are `action` values on `codespar_pay` / `codespar_invoice`,
// not separate tools. Loaded by the runtime through CODESPAR_PLUGINS. The core
// ships no built-in meta-tools; the demo opts in.
//
// Both the test-mode run (validate.sh, aimock-driven) and the live smoke
// (validate-live.sh, real Claude) run with CODESPAR_TEST_MODE_ENABLED=true, so
// the session `mocks` answer the meta-tool call before this hook's execute()
// runs — no provider credentials are ever needed. execute() is the live-path
// seam: it only runs against real rails, which this demo never exercises.
import {
  INVOICE_DEFINITION,
  NOTIFY_DEFINITION,
  PAY_DEFINITION,
} from "@codespar/types";

const hook = {
  id: "demo-boleto-expiry-fiscal-remediation",
  handles: ["codespar_invoice", "codespar_notify", "codespar_pay"],
  definitions: () => [INVOICE_DEFINITION, NOTIFY_DEFINITION, PAY_DEFINITION],
  async execute(name) {
    throw new Error(
      `demo meta-tool "${name}" reached the live path; this demo runs in test mode where the session mocks answer`,
    );
  },
};

export default function register(registry) {
  registry.registerMetaTool(hook);
}
