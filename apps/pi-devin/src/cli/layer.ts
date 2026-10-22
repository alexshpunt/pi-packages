import { Layer } from "effect";
import { NodeDeviceIdentitySource } from "../core/services/device-identity.ts";
import { NodeHttpTransport } from "../core/services/http-transport.ts";
import { NodePlatformLayer } from "../core/services/platform.ts";
import { NodeLoginUI } from "./services/login-ui.ts";
import { CLIOutputLive } from "./services/output.ts";
import { SessionStoreLive } from "./services/sessions.ts";
import { StateFilesLive } from "./services/state-files.ts";

/** Services of one CLI run: Node's network, process and file services, this PoC's state files, and the run's output. */
export const CLILive = Layer.mergeAll(CLIOutputLive, SessionStoreLive, NodeLoginUI, NodeHttpTransport(), NodeDeviceIdentitySource).pipe(
  Layer.provideMerge(StateFilesLive),
  Layer.provideMerge(NodePlatformLayer),
);

export type CLIServices = Layer.Success<typeof CLILive>;
