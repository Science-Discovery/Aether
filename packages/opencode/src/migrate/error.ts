export class MigrateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MigrateError"
  }
}
