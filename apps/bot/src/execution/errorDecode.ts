import { type Hex } from 'viem';

type ErrorDecodeResult = {
  errorCategory: string;
  errorMessage: string;
  errorSelector?: `0x${string}`;
  decodedErrorName?: string;
};

const ERROR_SELECTOR_TO_NAME = new Map<string, string>([
  ['0x5c427cd9', 'UnauthorizedCaller'],
  ['0x9e87fac8', 'Paused'],
  ['0x39d98dfa', 'UnsupportedOrderShape'],
  ['0xe4e9dcbc', 'UnsupportedOutputShape'],
  ['0xc4c321d1', 'BadRoute'],
  ['0x936bb5ad', 'TokenMismatch'],
  ['0xf8b3bb61', 'InsufficientInput'],
  ['0xbb2875c3', 'InsufficientOutput'],
  ['0x8199f5f3', 'SlippageExceeded'],
  ['0x798057ca', 'ExactOutputExceededMaxInput'],
  ['0xd92e233d', 'ZeroAddress'],
  ['0x30cd7471', 'NotOwner'],
  ['0xab143c06', 'Reentrancy'],
  ['0x6cd60201', 'NotPaused'],
  ['0x045c4b02', 'TokenTransferFailed'],
  ['0x2d4de02b', 'TokenApprovalFailed'],
  ['0xb08ce5b3', 'DeadlineReached'],
  ['0xac9143e7', 'InvalidCosignerInput'],
  ['0xa305df82', 'InvalidCosignerOutput'],
  ['0x0e996766', 'InvalidDecayCurve'],
  ['0xe318ce7d', 'MockReactorForcedRevertAfterCallback'],
  ['0xb9ec1e96', 'NoExclusiveOverride']
]);

const SELECTOR_REGEX = /0x[a-fA-F0-9]{8}/;

function isHexString(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && /^0x[a-fA-F0-9]+$/.test(value);
}

function extractSelectorFromText(text: string): `0x${string}` | undefined {
  const matches = text.match(SELECTOR_REGEX);
  if (!matches || matches.length === 0) return undefined;
  return matches[0].toLowerCase() as `0x${string}`;
}

function findSelectorDeep(input: unknown, seen = new Set<unknown>()): `0x${string}` | undefined {
  if (input === null || input === undefined) return undefined;
  if (typeof input === 'string') {
    if (isHexString(input) && input.length >= 10) {
      return input.slice(0, 10).toLowerCase() as `0x${string}`;
    }
    return extractSelectorFromText(input);
  }
  if (typeof input !== 'object') return undefined;
  if (seen.has(input)) return undefined;
  seen.add(input);

  const obj = input as Record<string, unknown>;

  for (const key of ['data', 'revertData', 'errorData']) {
    const value = obj[key];
    if (isHexString(value) && value.length >= 10) {
      return value.slice(0, 10).toLowerCase() as `0x${string}`;
    }
  }

  for (const key of ['shortMessage', 'message', 'details']) {
    const value = obj[key];
    if (typeof value === 'string') {
      const fromText = extractSelectorFromText(value);
      if (fromText) return fromText;
    }
  }

  const metaMessages = obj.metaMessages;
  if (Array.isArray(metaMessages)) {
    for (const item of metaMessages) {
      if (typeof item === 'string') {
        const fromText = extractSelectorFromText(item);
        if (fromText) return fromText;
      } else {
        const nested = findSelectorDeep(item, seen);
        if (nested) return nested;
      }
    }
  }

  const cause = obj.cause;
  if (cause !== undefined) {
    const nestedCause = findSelectorDeep(cause, seen);
    if (nestedCause) return nestedCause;
  }

  for (const value of Object.values(obj)) {
    const nested = findSelectorDeep(value, seen);
    if (nested) return nested;
  }
  return undefined;
}

function selectorFromHex(data: Hex | undefined): `0x${string}` | undefined {
  if (!data || data.length < 10) return undefined;
  return data.slice(0, 10).toLowerCase() as `0x${string}`;
}

export function decodeExecutionError(error: unknown): ErrorDecodeResult {
  const selector = findSelectorDeep(error);
  const revertDataSelector = selectorFromHex(selector as Hex | undefined);
  const errorSelector = revertDataSelector ?? selector;
  const decodedErrorName = errorSelector ? ERROR_SELECTOR_TO_NAME.get(errorSelector) : undefined;

  if (decodedErrorName) {
    return {
      errorCategory: 'CUSTOM_ERROR',
      errorMessage: decodedErrorName,
      errorSelector,
      decodedErrorName
    };
  }
  if (errorSelector) {
    return {
      errorCategory: 'CUSTOM_ERROR',
      errorMessage: error instanceof Error ? error.message || `custom error ${errorSelector}` : `custom error ${errorSelector}`,
      errorSelector,
      decodedErrorName: `UNKNOWN_SELECTOR_${errorSelector}`
    };
  }

  if (error instanceof Error) {
    return {
      errorCategory: error.name || 'Error',
      errorMessage: error.message || 'execution error',
      errorSelector
    };
  }

  return {
    errorCategory: 'UnknownError',
    errorMessage: String(error),
    errorSelector
  };
}
