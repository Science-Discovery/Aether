import z from "zod"

/** The bounded, standard MCP form vocabulary. Extended OpenAI forms are not advertised. */
export namespace NativeForm {
  const text = z.string().max(10_000)
  const count = z.number().int().min(0).max(10_000)
  const common = { title: text.nullish(), description: text.nullish() }
  const option = z.object({ const: text, title: text }).strict()
  const options = z.array(option).min(1).max(100)
  const choices = z.array(text).min(1).max(100)
  const single = z.union([
    z
      .object({
        ...common,
        type: z.literal("string"),
        enum: choices,
        enumNames: z.array(text).nullish(),
        default: text.nullish(),
      })
      .strict(),
    z.object({ ...common, type: z.literal("string"), oneOf: options, default: text.nullish() }).strict(),
  ])
  const multiple = z
    .object({
      ...common,
      type: z.literal("array"),
      items: z.union([
        z.object({ type: z.literal("string"), enum: choices }).strict(),
        z.object({ anyOf: options }).strict(),
      ]),
      minItems: count.nullish(),
      maxItems: count.nullish(),
      default: z.array(text).max(100).nullish(),
    })
    .strict()
  const scalar = z.union([
    z
      .object({
        ...common,
        type: z.literal("string"),
        format: z.enum(["email", "uri", "date", "date-time"]).nullish(),
        minLength: count.nullish(),
        maxLength: count.nullish(),
        default: text.nullish(),
      })
      .strict(),
    z
      .object({
        ...common,
        type: z.enum(["number", "integer"]),
        minimum: z.number().nullish(),
        maximum: z.number().nullish(),
        default: z.number().nullish(),
      })
      .strict(),
    z.object({ ...common, type: z.literal("boolean"), default: z.boolean().nullish() }).strict(),
  ])
  const schema = z
    .object({
      $schema: text.nullish(),
      type: z.literal("object"),
      properties: z.record(z.string().min(1).max(200), z.union([single, multiple, scalar])),
      required: z.array(z.string()).max(32).nullish(),
    })
    .strict()
  export const Value = z.union([text, z.number(), z.boolean(), z.array(text).max(100)])
  export const Field = z
    .object({
      name: z.string(),
      title: z.string(),
      description: z.string().optional(),
      type: z.enum(["string", "number", "integer", "boolean", "array"]),
      required: z.boolean(),
      options: z.array(z.object({ value: z.string(), title: z.string() })).optional(),
      format: z.enum(["email", "uri", "date", "date-time"]).optional(),
      min: z.number().optional(),
      max: z.number().optional(),
      default: Value.optional(),
    })
    .meta({ ref: "NativeElicitationField" })
  export type Field = z.infer<typeof Field>
  export const Content = z.record(z.string().max(200), Value)

  export function parse(value: unknown): Field[] {
    const parsed = schema.safeParse(value)
    if (!parsed.success)
      throw new Error(
        "This MCP form uses unsupported fields or constraints. Ask the tool to use a standard form or URL authorization.",
      )
    const data = parsed.data
    if (Object.keys(data.properties).length > 32 || data.required?.some((key) => !Object.hasOwn(data.properties, key)))
      throw new Error("This MCP form has too many fields or invalid required fields.")
    return Object.entries(data.properties).map(([name, item]) => {
      if (["__proto__", "constructor", "prototype"].includes(name)) throw new Error("Unsupported MCP form field name.")
      const choices =
        "enum" in item
          ? item.enum.map((value, index) => ({ value, title: item.enumNames?.[index] ?? value }))
          : "oneOf" in item
            ? item.oneOf.map((option) => ({ value: option.const, title: option.title }))
            : item.type === "array"
              ? "enum" in item.items
                ? item.items.enum.map((value) => ({ value, title: value }))
                : item.items.anyOf.map((option) => ({ value: option.const, title: option.title }))
              : undefined
      const field: Field = {
        name,
        title: item.title ?? name,
        description: item.description ?? undefined,
        type: item.type,
        required: data.required?.includes(name) ?? false,
        options: choices,
        format: "format" in item ? (item.format ?? undefined) : undefined,
        min:
          "minimum" in item
            ? (item.minimum ?? undefined)
            : "minLength" in item
              ? (item.minLength ?? undefined)
              : "minItems" in item
                ? (item.minItems ?? undefined)
                : undefined,
        max:
          "maximum" in item
            ? (item.maximum ?? undefined)
            : "maxLength" in item
              ? (item.maxLength ?? undefined)
              : "maxItems" in item
                ? (item.maxItems ?? undefined)
                : undefined,
        default: item.default ?? undefined,
      }
      if (
        (field.min !== undefined && field.max !== undefined && field.min > field.max) ||
        (choices && new Set(choices.map((item) => item.value)).size !== choices.length) ||
        ("enumNames" in item && item.enumNames && item.enumNames.length !== item.enum.length)
      )
        throw new Error("The MCP form has inconsistent constraints.")
      if (field.default !== undefined) validate(field, field.default)
      return field
    })
  }

  function validate(field: Field, value: z.infer<typeof Value>) {
    const invalid = () => {
      throw new Error(`Invalid answer for ${field.title}.`)
    }
    if (field.type === "boolean") return typeof value === "boolean" ? undefined : invalid()
    if (field.type === "number" || field.type === "integer") {
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        (field.type === "integer" && !Number.isInteger(value)) ||
        (field.min !== undefined && value < field.min) ||
        (field.max !== undefined && value > field.max)
      )
        invalid()
      return
    }
    if (field.type === "array") {
      if (
        !Array.isArray(value) ||
        new Set(value).size !== value.length ||
        value.some((item) => !field.options?.some((option) => option.value === item)) ||
        (field.min !== undefined && value.length < field.min) ||
        (field.max !== undefined && value.length > field.max)
      )
        invalid()
      return
    }
    if (typeof value !== "string") return invalid()
    if (
      (field.min !== undefined && [...value].length < field.min) ||
      (field.max !== undefined && [...value].length > field.max) ||
      (field.options && !field.options.some((item) => item.value === value))
    )
      invalid()
    if (field.format === "email" && !z.email().safeParse(value).success) invalid()
    if (field.format === "uri" && !z.url().safeParse(value).success) invalid()
    if (field.format === "date" && !z.iso.date().safeParse(value).success) invalid()
    if (field.format === "date-time" && !z.iso.datetime({ offset: true }).safeParse(value).success) invalid()
  }

  export function content(fields: Field[], value: unknown) {
    const data = Content.safeParse(value)
    if (!data.success) throw new Error("Invalid MCP form answers.")
    if (Object.keys(data.data).some((key) => !fields.some((field) => field.name === key)))
      throw new Error("Unknown MCP form field.")
    fields.forEach((field) => {
      if (!Object.hasOwn(data.data, field.name)) {
        if (field.required) throw new Error(`Answer required: ${field.title}.`)
        return
      }
      validate(field, data.data[field.name])
    })
    return data.data
  }
}
