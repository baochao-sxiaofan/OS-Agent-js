/**
 * Placeholder for a long-lived Agent's managed context.
 *
 * Only an empty object is representable for now. Context levels, task chains,
 * results and their lifecycle will be defined by this module later.
 * Vendor continuation data is not semantic Agent context.
 */
export type AgentContext = Readonly<Record<string, never>>;
