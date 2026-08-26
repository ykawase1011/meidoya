import { redactDeep, redactSecrets } from "@meidoya/agent-runtime";
import {
  DefaultLogger,
  Runtime,
  type Logger,
  type LogLevel,
  type LogMetadata,
  type RuntimeOptions,
} from "@temporalio/worker";

function redactMetadata(meta: LogMetadata | undefined): LogMetadata | undefined {
  if (meta === undefined) return undefined;
  const redacted = redactDeep(meta);
  return redacted !== null && typeof redacted === "object"
    ? (redacted as LogMetadata)
    : undefined;
}

export class RedactingTemporalLogger implements Logger {
  constructor(private readonly downstream: Logger = new DefaultLogger("INFO")) {}

  log(level: LogLevel, message: string, meta?: LogMetadata): void {
    this.downstream.log(level, redactSecrets(message), redactMetadata(meta));
  }

  trace(message: string, meta?: LogMetadata): void {
    this.log("TRACE", message, meta);
  }

  debug(message: string, meta?: LogMetadata): void {
    this.log("DEBUG", message, meta);
  }

  info(message: string, meta?: LogMetadata): void {
    this.log("INFO", message, meta);
  }

  warn(message: string, meta?: LogMetadata): void {
    this.log("WARN", message, meta);
  }

  error(message: string, meta?: LogMetadata): void {
    this.log("ERROR", message, meta);
  }
}

function safeRuntimeOptions(level: LogLevel): RuntimeOptions {
  return {
    logger: new RedactingTemporalLogger(new DefaultLogger(level)),
    telemetryOptions: { logging: { forward: { level } } },
  };
}

export function configureSafeTemporalRuntimeDefaults(level: LogLevel = "INFO"): void {
  Runtime.defaultOptions = safeRuntimeOptions(level);
}

export function installSafeTemporalRuntime(level: LogLevel = "INFO"): Runtime {
  return Runtime.install(safeRuntimeOptions(level));
}
