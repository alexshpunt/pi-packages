/** Pi's extension API behind the contracts the features declare. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect, Layer } from "effect";
import { ServerRegistrations } from "../servers/service.ts";
import { ToolHost } from "../tools/registry.ts";

export const PiToolHost = (pi: ExtensionAPI) =>
  Layer.succeed(ToolHost, {
    registerTool: (definition) => Effect.sync(() => pi.registerTool(definition)),
    allTools: Effect.sync(() => pi.getAllTools()),
    activeTools: Effect.sync(() => pi.getActiveTools()),
    setActiveTools: (names) => Effect.sync(() => pi.setActiveTools([...names])),
  });

export const PiServerRegistrations = (pi: ExtensionAPI) =>
  Layer.succeed(ServerRegistrations, { list: Effect.sync(() => pi.getMcpServers()) });
