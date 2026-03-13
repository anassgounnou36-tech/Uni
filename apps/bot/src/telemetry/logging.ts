export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogRecord = {
  level: LogLevel;
  event: string;
  at: string;
  fields?: Record<string, unknown>;
};

export interface StructuredLogger {
  log(level: LogLevel, event: string, fields?: Record<string, unknown>): void;
}

export class JsonConsoleLogger implements StructuredLogger {
  constructor(private readonly sink: (line: string) => void = console.log) {}

  log(level: LogLevel, event: string, fields?: Record<string, unknown>): void {
    const record: LogRecord = {
      level,
      event,
      at: new Date().toISOString(),
      ...(fields ? { fields } : {})
    };
    this.sink(JSON.stringify(record));
  }
}
