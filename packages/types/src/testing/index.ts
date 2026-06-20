export * from "./contract-suite.js";
export * from "./conformance-kit.js";

// Re-export the contract descriptors from the testing entrypoint too, so a
// conformance-test author imports the suite and the descriptors it drives
// from one place (`@codespar/types/testing`) rather than splitting imports
// between here and the package root.
export { META_TOOL_CONTRACTS } from "../meta-tool-contract.js";
export type { ContractedToolName } from "../meta-tool-contract.js";
