/* ── Meta-tool contract descriptor ───────────────────────────────
 *
 * A machine-readable description of a single meta-tool's contract: the
 * names of its wire types, its action state machine, and its error rules.
 * The conformance kit (`@codespar/types/testing`) consumes a descriptor and
 * asserts that whatever implementation is registered at a live backend
 * honors it — so the descriptor is the single source of truth for "what it
 * means to conform", and both the OSS runtime and a managed backend prove
 * parity by passing the same descriptor-driven suite.
 *
 * Descriptors are data, not code paths: they reference wire shapes by name
 * (the interfaces authored in `types.ts`) rather than carrying validators,
 * so they stay portable across language ports and serialize cleanly.
 * ─────────────────────────────────────────────────────────────── */

/**
 * A field's required wire shape, expressed as a JSON-value kind. The kit
 * uses these to assert wire-shape validity without importing a schema
 * library: each kind maps to a `typeof`/`Array.isArray` check.
 *
 * `string-enum` additionally constrains the value to a closed set (see
 * {@link FieldRule.values}).
 */
export type FieldKind =
  | "string"
  | "string-enum"
  | "number"
  | "boolean"
  | "object"
  | "array";

/** One field's contract within a wire shape. */
export interface FieldRule {
  /** The field name on the wire object. */
  name: string;
  /** The required JSON-value kind. */
  kind: FieldKind;
  /** Whether the field must be present (and non-null). Defaults to true. */
  required?: boolean;
  /** Closed value set — required when `kind` is "string-enum". */
  values?: readonly string[];
}

/**
 * A named wire shape: the set of field rules an instance of the shape must
 * satisfy. A conforming implementation MAY carry optional fields beyond
 * these (subset-shape), but MUST carry every `required` field with the
 * stated kind.
 */
export interface WireShape {
  /** The interface name in `types.ts`, e.g. "ShopSearchResult". */
  name: string;
  /** Field-level rules the result object must satisfy. */
  fields: readonly FieldRule[];
}

/**
 * One action a meta-tool exposes, with the input it is driven by and the
 * result wire shape it returns. `terminal` marks an action whose result
 * carries a terminal status (the state machine cannot advance past it).
 */
export interface ActionRule {
  /** The `action` discriminator value, e.g. "search". */
  action: string;
  /** A minimal valid input the kit can post to drive this action. The
   *  `action` field is added by the kit, so omit it here. */
  sampleInput: Record<string, unknown>;
  /** The result wire shape this action returns. */
  result: WireShape;
  /** The `status` field on the result that the state machine reads, when
   *  this action's result participates in the state machine. */
  statusField?: string;
}

/**
 * The action state machine for a meta-tool. `actions` is keyed by the
 * `action` discriminator; `terminalStatuses` is the closed set of status
 * values that end a flow (no further action advances past them); `start`
 * names the action a flow begins at.
 *
 * Example (shop): start `search`, advance through `checkout` to
 * `checkout_status`, whose `ready_for_payment` / `canceled` are terminal.
 */
export interface ActionStateMachine {
  /** The action a flow begins at. */
  start: string;
  /** Every action the tool exposes, keyed by the discriminator value. */
  actions: readonly ActionRule[];
  /** Status values that terminate a flow. */
  terminalStatuses: readonly string[];
}

/**
 * The error rules a meta-tool must honor. These are the two
 * implementation-agnostic guarantees every contract'd meta-tool makes,
 * regardless of which runtime serves it.
 */
export interface ErrorRules {
  /**
   * The error a runtime returns when the tool has no registered
   * implementation. The runtime returns a `ToolResult` with
   * `success: false` and an `error` that starts with this string —
   * never an HTTP error. The literal is "Tool not registered".
   */
  unregisteredErrorPrefix: string;
  /**
   * A malformed input the kit posts to assert the runtime returns a typed
   * error envelope (`success: false`, non-empty `error`) rather than
   * throwing across the wire or returning a success result. The `action`
   * field is added by the kit when `malformedAction` is set.
   */
  malformedInput: Record<string, unknown>;
  /** The action to drive the malformed input against, when the tool is
   *  action-based. Omit for tools with no action discriminator. */
  malformedAction?: string;
}

/**
 * The happy-path contract for a single-shot tool — one with no action
 * discriminator (e.g. `codespar_discover`). Names a minimal valid input to
 * drive the tool with and the result wire shape the response must satisfy,
 * so the kit asserts the result shape rather than only that it succeeded.
 */
export interface SingleShotRule {
  /** A minimal valid input the kit posts to drive the happy path. */
  sampleInput: Record<string, unknown>;
  /** The result wire shape the successful response must satisfy. */
  result: WireShape;
}

/**
 * The full contract descriptor for one meta-tool — the machine-readable
 * contract the conformance kit consumes. Names the tool, its wire types,
 * its action state machine (or single-shot rule), and its error rules.
 *
 * Exactly one of `stateMachine` (action-discriminated tools) or
 * `singleShot` (tools with no action) describes the happy path.
 */
export interface MetaToolContractDescriptor {
  /** The wire tool name, e.g. "codespar_shop". */
  toolName: string;
  /** The Args interface name in `types.ts`, e.g. "ShopArgs". */
  argsType: string;
  /** The Result interface (or union) name in `types.ts`, e.g.
   *  "ShopResult". */
  resultType: string;
  /** The action state machine. Present for action-discriminated tools. */
  stateMachine?: ActionStateMachine;
  /** The single-shot happy-path rule. Present for tools with no action
   *  discriminator (mutually exclusive with `stateMachine`). */
  singleShot?: SingleShotRule;
  /** The error rules every runtime serving this tool must honor. */
  errors: ErrorRules;
}

/** The literal a runtime returns for a tool with no registered impl. */
export const TOOL_NOT_REGISTERED_PREFIX = "Tool not registered" as const;

/* ── codespar_discover ───────────────────────────────────────── */

/**
 * `codespar_discover` is a single-shot search (no action discriminator):
 * it takes a `use_case` and returns a `DiscoverResult`. The contract is the
 * result wire shape (DiscoverResult's real fields) plus the two error
 * rules. `recommended` is intentionally not required: it is nullable by
 * contract (`DiscoverToolMatch | null`), so a conforming result MAY return
 * `recommended: null` — when present it must be an object.
 */
export const DISCOVER_CONTRACT: MetaToolContractDescriptor = {
  toolName: "codespar_discover",
  argsType: "DiscoverOptions",
  resultType: "DiscoverResult",
  singleShot: {
    sampleInput: { use_case: "test conformance probe" },
    result: {
      name: "DiscoverResult",
      fields: [
        { name: "use_case", kind: "string" },
        {
          name: "search_strategy",
          kind: "string-enum",
          values: ["embedding", "trigram", "empty"],
        },
        { name: "recommended", kind: "object", required: false },
        { name: "related", kind: "array" },
        { name: "next_steps", kind: "array" },
      ],
    },
  },
  errors: {
    unregisteredErrorPrefix: TOOL_NOT_REGISTERED_PREFIX,
    // A discover call with no use_case is malformed — the tool cannot
    // search for nothing.
    malformedInput: {},
  },
};

/* ── codespar_manage_connections ─────────────────────────────── */

/**
 * `codespar_manage_connections` is action-discriminated over
 * `list | status | initiate`, but the actions do not form a sequential
 * flow — each is an independent read/initiate against a server's
 * connection state, so there is no terminal-status state machine. The
 * contract names the per-action result shape and the error rules.
 */
export const MANAGE_CONNECTIONS_CONTRACT: MetaToolContractDescriptor = {
  toolName: "codespar_manage_connections",
  argsType: "ConnectionWizardOptions",
  resultType: "ConnectionWizardResult",
  stateMachine: {
    start: "list",
    actions: [
      {
        action: "list",
        sampleInput: {},
        result: {
          name: "ConnectionWizardResult",
          fields: [
            { name: "action", kind: "string-enum", values: ["list"] },
            { name: "connections", kind: "array" },
          ],
        },
      },
      {
        action: "status",
        sampleInput: { server_id: "asaas" },
        result: {
          name: "ConnectionWizardResult",
          fields: [
            { name: "action", kind: "string-enum", values: ["status"] },
            { name: "connections", kind: "array" },
            // `status` is `ConnectionStatusRow | null` — an object when a
            // row is found, null when the server is unknown. Validated
            // only when present.
            { name: "status", kind: "object", required: false },
          ],
        },
      },
      {
        action: "initiate",
        sampleInput: { server_id: "asaas" },
        result: {
          name: "ConnectionWizardResult",
          fields: [
            { name: "action", kind: "string-enum", values: ["initiate"] },
            { name: "connections", kind: "array" },
            // `initiate` is `ConnectionWizardInstructions | null` — an
            // object when the wizard is issued, null otherwise. Validated
            // only when present.
            { name: "initiate", kind: "object", required: false },
          ],
        },
      },
    ],
    // No flow terminus — each action is independent.
    terminalStatuses: [],
  },
  errors: {
    unregisteredErrorPrefix: TOOL_NOT_REGISTERED_PREFIX,
    // An unknown action is malformed — the closed set is
    // list | status | initiate.
    malformedInput: { action: "not_a_real_action" },
    malformedAction: "not_a_real_action",
  },
};

/* ── codespar_shop ───────────────────────────────────────────── */

/**
 * `codespar_shop` is the canonical action state machine: `search` finds
 * offers, `checkout` starts an async session, and `checkout_status` polls
 * to a terminal `ready_for_payment` (carries a payable Pix) or `canceled`
 * (carries an error). The `in_progress` status is non-terminal — the flow
 * advances by re-polling `checkout_status`.
 */
export const SHOP_CONTRACT: MetaToolContractDescriptor = {
  toolName: "codespar_shop",
  argsType: "ShopArgs",
  resultType: "ShopResult",
  stateMachine: {
    start: "search",
    actions: [
      {
        action: "search",
        sampleInput: { query: "cat food" },
        result: {
          name: "ShopSearchResult",
          fields: [
            { name: "rail", kind: "string" },
            { name: "products", kind: "array" },
          ],
        },
      },
      {
        action: "checkout",
        sampleInput: { url: "https://example.test/p/sku_1" },
        result: {
          name: "ShopCheckoutResult",
          fields: [
            { name: "checkout_session_id", kind: "string" },
            {
              name: "status",
              kind: "string-enum",
              values: ["in_progress"],
            },
          ],
        },
        statusField: "status",
      },
      {
        action: "checkout_status",
        sampleInput: { checkout_session_id: "cks_sample" },
        result: {
          name: "ShopStatusResult",
          fields: [
            { name: "checkout_session_id", kind: "string" },
            {
              name: "status",
              kind: "string-enum",
              values: ["in_progress", "ready_for_payment", "canceled"],
            },
          ],
        },
        statusField: "status",
      },
    ],
    terminalStatuses: ["ready_for_payment", "canceled"],
  },
  errors: {
    unregisteredErrorPrefix: TOOL_NOT_REGISTERED_PREFIX,
    // A search with no query is malformed — there is nothing to search for.
    malformedInput: {},
    malformedAction: "search",
  },
};

/** Every in-scope contract descriptor, keyed by wire tool name. */
export const META_TOOL_CONTRACTS = {
  codespar_discover: DISCOVER_CONTRACT,
  codespar_manage_connections: MANAGE_CONNECTIONS_CONTRACT,
  codespar_shop: SHOP_CONTRACT,
} as const;

/** The wire tool names that have a published contract descriptor. */
export type ContractedToolName = keyof typeof META_TOOL_CONTRACTS;
