import { logger } from "../utils/logger.js";

export interface ShutdownParticipant {
  name: string;
  beginDrain?: () => Promise<void> | void;
  drain: () => Promise<void> | void;
}

export class GracefulShutdown {
  private draining = false;

  constructor(
    private readonly participants: ShutdownParticipant[],
    private readonly graceMs: number,
    private readonly exit: (code: number) => never = process.exit,
  ) {}

  install(): void {
    process.once("SIGTERM", () => void this.shutdown("SIGTERM"));
    process.once("SIGINT", () => void this.shutdown("SIGINT"));
  }

  async shutdown(signal: "SIGTERM" | "SIGINT"): Promise<void> {
    if (this.draining) {
      logger.warn({ signal }, "Shutdown already in progress");
      return;
    }

    this.draining = true;
    logger.info({ signal, graceMs: this.graceMs }, "Shutdown drain started");

    try {
      await Promise.all(this.participants.map(async ({ name, beginDrain }) => {
        await beginDrain?.();
        logger.info({ worker: name }, "Worker intake paused");
      }));

      let graceTimer: NodeJS.Timeout;
      const graceExceeded = new Promise<boolean>((resolve) => {
        graceTimer = setTimeout(() => resolve(false), this.graceMs);
      });
      const completed = await Promise.race([
        Promise.all(this.participants.map(async ({ name, drain }) => {
          await drain();
          logger.info({ worker: name }, "Worker drain completed");
        })).then(() => true),
        graceExceeded,
      ]);
      clearTimeout(graceTimer!);

      if (!completed) {
        logger.error({ graceMs: this.graceMs }, "Shutdown grace period exceeded; forcing exit");
        this.exit(1);
      }

      logger.info("Shutdown drain completed; exiting");
      this.exit(0);
    } catch (error) {
      logger.error({ error }, "Shutdown drain failed; forcing exit");
      this.exit(1);
    }
  }
}
