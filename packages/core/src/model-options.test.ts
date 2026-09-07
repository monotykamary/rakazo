import type { ModelCatalogEntry, ModelCredential } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { connectedModelOptions, modelOptionKey, parseModelOptionKey } from "./model-options.js";

const credential = (provider: string, modelId: string): ModelCredential =>
  ({ provider, modelId, label: provider, thinkingLevels: ["low", "high"] }) as ModelCredential;
const model = (provider: string, id: string): ModelCatalogEntry =>
  ({
    provider,
    id,
    label: id,
    thinkingLevels: ["minimal"],
    placeholder: false,
  }) as ModelCatalogEntry;
describe("connected model choices", () => {
  it("expands connected catalog providers only, excluding placeholders and duplicates", () => {
    const catalog = [
      model("local", "one"),
      model("local", "two"),
      model("unconnected", "three"),
      { ...model("local", "placeholder"), placeholder: true },
    ];
    expect(
      connectedModelOptions([credential("local", "one"), credential("local", "one")], catalog).map(
        (entry) => entry.modelId,
      ),
    ).toEqual(["one", "two"]);
  });
  it("keeps free-form models and their capability metadata", () => {
    expect(
      connectedModelOptions([credential("compatible", "custom")], [model("compatible", "other")]),
    ).toEqual([
      {
        key: "compatible::custom",
        provider: "compatible",
        modelId: "custom",
        label: "compatible · custom",
        thinkingLevels: ["low", "high"],
      },
    ]);
  });
  it("round-trips punctuated model ids", () => {
    expect(parseModelOptionKey(modelOptionKey("local", "family::model"))).toEqual({
      provider: "local",
      modelId: "family::model",
    });
    expect(parseModelOptionKey("broken")).toBeNull();
  });
});
