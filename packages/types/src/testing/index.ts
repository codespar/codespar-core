export * from "./contract-suite.js";
export * from "./conformance-kit.js";
export * from "./demo-scenario.js";
export { SERVICE_INVOICE_SCENARIO } from "./demo-scenarios/service-invoice.js";
export { INSTALLMENT_NEGOTIATION_SCENARIO } from "./demo-scenarios/installment-negotiation.js";
export { PAYMENT_REJECTION_SCENARIO } from "./demo-scenarios/payment-rejection.js";
export { CUSTOMER_DATA_REJECTION_SCENARIO } from "./demo-scenarios/customer-data-rejection.js";
export { MERCHANT_BLOCKED_SCENARIO } from "./demo-scenarios/merchant-blocked.js";
export { BOLETO_EXPIRED_NFE_CORRECTION_SCENARIO } from "./demo-scenarios/boleto-expired-nfe-correction.js";
export { BOLETO_EXPIRED_NFE_REISSUE_SCENARIO } from "./demo-scenarios/boleto-expired-nfe-reissue.js";
export { DEMO_SCENARIO_MANIFEST } from "./scenario-manifest.js";
export type { DemoScenarioName } from "./scenario-manifest.js";

// Re-export the contract descriptors from the testing entrypoint too, so a
// conformance-test author imports the suite and the descriptors it drives
// from one place (`@codespar/types/testing`) rather than splitting imports
// between here and the package root.
export { META_TOOL_CONTRACTS } from "../meta-tool-contract.js";
export type { ContractedToolName } from "../meta-tool-contract.js";
