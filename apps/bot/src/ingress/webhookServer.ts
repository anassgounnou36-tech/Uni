import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isRequestAllowlisted } from './ipAllowlist.js';
import type { IngressEnvelope, UniswapWebhookPayload } from './types.js';
import { parseWebhookPayload } from './webhookSchema.js';
import type { BotMetrics } from '../telemetry/metrics.js';

export type WebhookServerConfig = {
  host: string;
  port: number;
  path: string;
  trustProxy: boolean;
  allowedCidrs: readonly string[];
  maxBodyBytes: number;
  metrics?: BotMetrics;
};

export type WebhookIngressHandler = (envelope: IngressEnvelope<UniswapWebhookPayload>) => Promise<void>;

async function readBody(request: IncomingMessage, maxBodyBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const piece = Buffer.from(chunk);
    size += piece.length;
    if (size > maxBodyBytes) {
      throw new Error('BODY_TOO_LARGE');
    }
    chunks.push(piece);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function toCreatedAtMs(value: string | number): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  const asNumber = Number(value);
  if (Number.isFinite(asNumber)) {
    return asNumber;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return undefined;
  }
  return parsed;
}

export class WebhookIngressServer {
  private readonly server;

  constructor(
    private readonly config: WebhookServerConfig,
    private readonly handler: WebhookIngressHandler
  ) {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST' || request.url !== this.config.path) {
      response.statusCode = 404;
      response.end('not found');
      return;
    }

    const allowlist = isRequestAllowlisted(request, this.config.trustProxy, this.config.allowedCidrs);
    if (!allowlist.allowed) {
      response.statusCode = 403;
      response.end('forbidden');
      return;
    }

    try {
      const body = await readBody(request, this.config.maxBodyBytes);
      const parsedBody = JSON.parse(body) as unknown;
      const parsed = parseWebhookPayload(parsedBody);
      if (!parsed.success) {
        response.statusCode = 400;
        response.end('invalid webhook payload');
        return;
      }

      const receivedAtMs = Date.now();
      const createdAtMs = toCreatedAtMs(parsed.data.createdAt);
      if (createdAtMs !== undefined) {
        this.config.metrics?.observeHistogram('webhook_created_to_received_ms', Math.max(0, receivedAtMs - createdAtMs));
      }
      await this.handler({
        source: 'WEBHOOK',
        receivedAtMs,
        payload: parsed.data,
        createdAtMs,
        orderHashHint: parsed.data.orderHash,
        remoteIp: allowlist.ip
      });

      response.statusCode = 202;
      response.end('accepted');
    } catch (error) {
      if (error instanceof Error && error.message === 'BODY_TOO_LARGE') {
        response.statusCode = 400;
        response.end('payload too large');
        return;
      }
      response.statusCode = 500;
      response.end('internal error');
    }
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.listen(this.config.port, this.config.host, () => resolve());
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}
