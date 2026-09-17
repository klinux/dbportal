/** A refusal of an account provisioning, carrying the status its route answers with. */
export class ProvisionError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "ProvisionError";
    Object.setPrototypeOf(this, ProvisionError.prototype);
  }
}
