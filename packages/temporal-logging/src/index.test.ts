import type { Logger, LogLevel, LogMetadata } from "@temporalio/worker";
import { describe, expect, it } from "vitest";
import { RedactingTemporalLogger } from "./index.js";

class CapturingLogger implements Logger {
  readonly entries: { level: LogLevel; message: string; meta?: LogMetadata }[] = [];

  log(level: LogLevel, message: string, meta?: LogMetadata): void {
    this.entries.push({ level, message, ...(meta === undefined ? {} : { meta }) });
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

describe("RedactingTemporalLogger", () => {
  it("never forwards a task token or a credential-shaped message", () => {
    const downstream = new CapturingLogger();
    const logger = new RedactingTemporalLogger(downstream);
    const taskToken = ["opaque", "task", "value"].join("-");
    const messageSecret = ["ghp_", "DUMMYnotarealtoken0123456789"].join("");

    logger.warn(`failed with ${messageSecret}`, {
      taskToken,
      workflowId: "workflow-1",
      nested: { authorization: "opaque-authorization" },
    });

    expect(downstream.entries).toEqual([
      {
        level: "WARN",
        message: "failed with [redacted]",
        meta: {
          taskToken: "[redacted]",
          workflowId: "workflow-1",
          nested: { authorization: "[redacted]" },
        },
      },
    ]);
    expect(JSON.stringify(downstream.entries)).not.toContain(taskToken);
    expect(JSON.stringify(downstream.entries)).not.toContain(messageSecret);
  });
});
