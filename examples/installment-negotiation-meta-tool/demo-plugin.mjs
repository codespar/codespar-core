// Demo plugin for the installment-negotiation meta-tool example.
//
// Registers `codespar_invoice`, `codespar_notify`, and `codespar_pay` as
// meta-tools on the runtime via the MetaToolHook seam, using the shared
// definitions published from @codespar/types. Loaded by the runtime through
// CODESPAR_PLUGINS. The core ships no built-in meta-tools; the demo opts in.
//
// The demo runs in test mode, where the session `mocks` answer the meta-tool
// call before this hook's execute() runs. execute() is the live-path seam.
import { INVOICE_DEFINITION, NOTIFY_DEFINITION, PAY_DEFINITION } from "@codespar/types";

const hook = {
  id: "demo-installment-negotiation",
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
