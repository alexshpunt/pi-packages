import { Console, Context, Effect, Layer } from "effect";
import type { JsonObject } from "../../core/types.ts";

/** JSON Lines events on stdout and the run report. The session token, once known, never appears in either. */
export class CLIOutputLog {
  private secret = "";
  report: JsonObject | undefined;
  reportPath: string | undefined;

  setSecret(secret: string): Effect.Effect<void> {
    return Effect.sync(() => { this.secret = secret; });
  }

  get secrets(): string[] { return [this.secret]; }

  serialized(value: unknown, indent?: number): string {
    const text = JSON.stringify(value, null, indent);
    return this.secret ? text.split(JSON.stringify(this.secret).slice(1, -1)).join("[REDACTED]") : text;
  }

  emit(event: string, data: JsonObject = {}): Effect.Effect<void> {
    return Effect.suspend(() => Console.log(this.serialized({ event, ...data })));
  }

  /** Streams model text to stderr without control characters or the token. */
  text(delta: string): Effect.Effect<void> {
    return Effect.sync(() => {
      const text = delta.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
      process.stderr.write(this.secret ? text.split(this.secret).join("[REDACTED]") : text);
    });
  }
}

/** The output of one CLI run. */
export class CLIOutput extends Context.Service<CLIOutput, CLIOutputLog>()("pi-devin/cli/CLIOutput") {}

export const CLIOutputLive = Layer.sync(CLIOutput, () => new CLIOutputLog());
