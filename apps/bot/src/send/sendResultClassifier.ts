export type JsonRpcErrorShape = {
  code: number;
  message: string;
};

export type SendResultClassification =
  | 'accepted'
  | 'sequencer_rejected'
  | 'limit_exceeded'
  | 'nonce_too_low'
  | 'replacement_underpriced'
  | 'already_known'
  | 'transport_error'
  | 'unknown_error';

export type SendResult = {
  ok: boolean;
  txHash?: `0x${string}`;
  error?: JsonRpcErrorShape;
  transportError?: unknown;
};

export function classifySendResult(result: SendResult): SendResultClassification {
  if (result.ok && result.txHash) {
    return 'accepted';
  }
  if (result.transportError) {
    return 'transport_error';
  }
  const error = result.error;
  if (!error) {
    return 'unknown_error';
  }
  if (error.code === -32003) {
    return 'sequencer_rejected';
  }
  if (error.code === -32005) {
    return 'limit_exceeded';
  }

  const message = error.message.toLowerCase();
  if (message.includes('nonce too low')) {
    return 'nonce_too_low';
  }
  if (message.includes('underpriced') || message.includes('replacement transaction underpriced')) {
    return 'replacement_underpriced';
  }
  if (message.includes('already known')) {
    return 'already_known';
  }
  return 'unknown_error';
}
