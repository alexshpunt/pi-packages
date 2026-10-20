// Pi extension for host-contract verification. Registers only a pure add tool with no file, shell or network access.
export default function addToolExtension(pi) {
  pi.registerTool({
    name: "add",
    label: "Add",
    description: "Add two integers and return the sum.",
    parameters: {
      type: "object",
      properties: { a: { type: "integer" }, b: { type: "integer" } },
      required: ["a", "b"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params) {
      const { a, b } = params;
      if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) throw new Error("add expects two safe integers");
      return { content: [{ type: "text", text: String(a + b) }], details: { sum: a + b } };
    },
  });
}
