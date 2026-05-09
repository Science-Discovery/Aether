import * as util from "@ai-sdk/provider-utils"

type Factory = typeof util.createProviderDefinedToolFactory
type Output = typeof util.createProviderDefinedToolFactoryWithOutputSchema

const mod = util as unknown as Record<string, unknown>

export const createProviderDefinedToolFactory = (mod.createProviderDefinedToolFactory ??
  mod.createProviderToolFactory) as Factory

export const createProviderDefinedToolFactoryWithOutputSchema =
  (mod.createProviderDefinedToolFactoryWithOutputSchema ?? mod.createProviderToolFactoryWithOutputSchema) as Output
