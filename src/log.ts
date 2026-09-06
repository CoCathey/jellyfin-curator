export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const consoleLogger: Logger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(`WARN ${message}`),
  error: (message) => console.error(`ERROR ${message}`),
};

/** Test double: keeps every line so tests can assert on what was reported. */
export class MemoryLogger implements Logger {
  readonly lines: string[] = [];
  info(message: string): void {
    this.lines.push(`info ${message}`);
  }
  warn(message: string): void {
    this.lines.push(`warn ${message}`);
  }
  error(message: string): void {
    this.lines.push(`error ${message}`);
  }
}
