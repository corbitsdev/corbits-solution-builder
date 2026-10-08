/**
 * What a build does first (CL-9981, CL-9987). Identical packets produced one
 * build that followed the design and one that spent its effort hardening a
 * password gate; and a quarter of fresh builds ended while a sub-agent was
 * still writing the app, so nothing landed.
 */
export const BUILD_ORDER_RULE = [
  `Build in this order. First, the main flow working end to end, in the approved design (its screens, states, copy and data-testids) and with the components the plan names. Then the remaining requirements. Then anything the PRD does not ask for, such as extra hardening or review passes, only once the rest is done.`,
  ``,
  `Never end your run while an agent you started is still working: wait for its report. A run that ends with work in flight leaves that work unwritten.`,
].join("\n");
