/** An error that maps to a specific HTTP status (the Fastify error handler honours `statusCode`). */
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
export const notFound = (what: string) => new HttpError(404, `${what} not found`);
export const conflict = (msg: string) => new HttpError(409, msg);
