/** A backup or restore refused or failed, with the status the route answers. The message never carries a credential or a tool's stderr. */
export class BackupError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "BackupError";
  }
}
