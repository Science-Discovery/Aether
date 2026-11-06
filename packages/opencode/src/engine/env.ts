export function env() {
  const value = { ...process.env }
  for (const key of Object.keys(value)) {
    if (key.startsWith("OPENCODE_")) delete value[key]
  }
  return value
}
