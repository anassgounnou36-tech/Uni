export const HEDGE_EXECUTION_MODES = ['EXACT_INPUT', 'EXACT_OUTPUT'] as const;
export type HedgeExecutionMode = (typeof HEDGE_EXECUTION_MODES)[number];
