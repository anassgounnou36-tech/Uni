import { type Hex } from 'viem';

type ErrorDecodeResult = {
  errorCategory: string;
  errorMessage: string;
  errorSelector?: `0x${string}`;
  decodedErrorName?: string;
};

const ERROR_SELECTOR_TO_NAME = new Map<string, string>([
  ['0x01d5062a', 'UnauthorizedCaller'],
  ['0x9e87fac8', 'Paused'],
  ['0x4f1d66ad', 'UnsupportedOrderShape'],
  ['0x1f95fdd9', 'UnsupportedOutputShape'],
  ['0x6e5dc177', 'BadRoute'],
  ['0xcfa3bce1', 'TokenMismatch'],
  ['0xf4d678b8', 'InsufficientInput'],
  ['0x8f7f8a2b', 'InsufficientOutput'],
  ['0xecd5d096', 'SlippageExceeded'],
  ['0xee6f1f21', 'ExactOutputExceededMaxInput'],
  ['0xd92e233d', 'ZeroAddress'],
  ['0x30cd7471', 'NotOwner'],
  ['0xab143c06', 'Reentrancy'],
  ['0xd7e6bcf8', 'NotPaused'],
  ['0x90b8ec18', 'TokenTransferFailed'],
  ['0x3e3f8f73', 'TokenApprovalFailed']
]);

function extractRevertData(error: unknown): Hex | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const value = error as { data?: unknown; cause?: unknown };
  if (typeof value.data === 'string' && value.data.startsWith('0x')) {
    return value.data as Hex;
  }
  if (value.cause && typeof value.cause === 'object') {
    const cause = value.cause as { data?: unknown };
    if (typeof cause.data === 'string' && cause.data.startsWith('0x')) {
      return cause.data as Hex;
    }
  }
  return undefined;
}

function selectorFromHex(data: Hex | undefined): `0x${string}` | undefined {
  if (!data || data.length < 10) return undefined;
  return data.slice(0, 10).toLowerCase() as `0x${string}`;
}

export function decodeExecutionError(error: unknown): ErrorDecodeResult {
  const revertData = extractRevertData(error);
  const errorSelector = selectorFromHex(revertData);
  const decodedErrorName = errorSelector ? ERROR_SELECTOR_TO_NAME.get(errorSelector) : undefined;

  if (decodedErrorName) {
    return {
      errorCategory: 'CUSTOM_ERROR',
      errorMessage: decodedErrorName,
      errorSelector,
      decodedErrorName
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
