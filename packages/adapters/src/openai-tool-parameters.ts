/**
 * OpenAI chat-completions `tools[].function.parameters` must be a JSON Schema
 * object. Some compatible servers reject a missing object envelope even when
 * the schema is a top-level union.
 */
export function normalizeOpenAiToolParameters(parameters: unknown): Record<string, unknown> {
  const schema =
    parameters && typeof parameters === "object" && !Array.isArray(parameters)
      ? { ...(parameters as Record<string, unknown>) }
      : {};
  const properties =
    schema.properties != null &&
    typeof schema.properties === "object" &&
    !Array.isArray(schema.properties)
      ? schema.properties
      : {};
  return { ...schema, type: "object", properties };
}

export function openAiToolParametersNeedNormalization(parameters: unknown): boolean {
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) return true;
  const schema = parameters as Record<string, unknown>;
  return (
    schema.type !== "object" ||
    schema.properties == null ||
    typeof schema.properties !== "object" ||
    Array.isArray(schema.properties)
  );
}
