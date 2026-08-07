export type ModelCapabilities = {
  tool_call?: boolean
  attachment?: boolean
  modalities?: { input?: string[] }
  capabilities?: {
    toolcall?: boolean
    input?: {
      image?: boolean
      pdf?: boolean
    }
  }
}

export function toolcall(model: ModelCapabilities) {
  return model.capabilities?.toolcall ?? model.tool_call ?? false
}

export function attachmentInput(model: ModelCapabilities) {
  return {
    image: model.capabilities?.input?.image ?? model.modalities?.input?.includes("image") ?? model.attachment ?? false,
    pdf: model.capabilities?.input?.pdf ?? model.modalities?.input?.includes("pdf") ?? false,
  }
}
