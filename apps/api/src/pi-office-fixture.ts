import assert from "node:assert/strict";
import type { PiModelRuntimeService } from "@rakazo/adapters";
import type { ModelSelection } from "@rakazo/contracts";

const model: ModelSelection = {
  provider: "fixture",
  modelId: "office-model",
  thinkingLevel: "off",
};

// This fake stands in for each independently configured office, never a real Pi profile.
export async function resolveFixtureOfficeModels(): Promise<PiModelRuntimeService> {
  return {
    read: async () => ({
      catalog: [
        {
          provider: model.provider,
          id: model.modelId,
          label: "Office fixture",
          billing: "offline",
          thinkingLevels: ["off"],
        },
      ],
      profileDefault: { ...model },
    }),
    validate: async (selection) => {
      assert.deepEqual(
        selection,
        model,
        "The destination must support the exact Pi model and reasoning level",
      );
    },
  };
}
