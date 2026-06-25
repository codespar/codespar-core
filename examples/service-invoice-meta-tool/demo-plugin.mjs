// Demo plugin for the service-invoice meta-tool example.
//
// Registers `codespar_invoice` + `codespar_notify` as meta-tools on the
// runtime via the MetaToolHook seam, using the shared definitions published
// from @codespar/types. Loaded by the runtime through CODESPAR_PLUGINS. This is
// the "you choose which tools to put behind a meta-tool" story: the core ships
// no built-in meta-tools; the demo opts in.
//
// The demo runs in test mode, where the session `mocks` answer the meta-tool
// call before this hook's execute() runs. execute() is the live-path seam.
import { INVOICE_DEFINITION, NOTIFY_DEFINITION } from "@codespar/types";

const hook = {
  id: "demo-service-invoice",
  handles: ["codespar_invoice", "codespar_notify"],
  definitions: () => [INVOICE_DEFINITION, NOTIFY_DEFINITION],
  async execute(name) {
    throw new Error(
      `demo meta-tool "${name}" reached the live path; this demo runs in test mode where the session mocks answer`,
    );
  },
};

export default function register(registry) {
  registry.registerMetaTool(hook);
}
