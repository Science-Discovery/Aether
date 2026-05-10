import { Schema } from "effect"
import z from "zod"

import { withStatics } from "@/util/schema"
import { Hash } from "@/util/hash"

const projectIdSchema = Schema.String.pipe(Schema.brand("ProjectID"))

export type ProjectID = typeof projectIdSchema.Type

export const ProjectID = projectIdSchema.pipe(
  withStatics((schema: typeof projectIdSchema) => ({
    global: schema.makeUnsafe("global"),
    make: (id: string) => schema.makeUnsafe(id),
    fromDirectory: (directory: string) => schema.makeUnsafe(Hash.fast(directory)),
    zod: z.string().pipe(z.custom<ProjectID>()),
  })),
)
