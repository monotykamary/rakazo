import { ORPCError } from "@orpc/server";
import {
  MachineRelocationError,
  relocateBotMachine as relocateSharedBotMachine,
} from "@rakazo/adapters";

export type {
  MachineRelocationDeps,
  MachineRelocationInput,
  RelocationComputer,
} from "@rakazo/adapters";

export const relocateBotMachine: typeof relocateSharedBotMachine = async (...args) => {
  try {
    return await relocateSharedBotMachine(...args);
  } catch (error) {
    if (error instanceof MachineRelocationError)
      throw new ORPCError(error.code, { message: error.message, cause: error });
    throw error;
  }
};
