import { homedir } from "node:os";
import { join } from "node:path";

export interface CoreOptions {
  readonly dataDirectory?: string;
}
export const resolveDataDirectory = (options: CoreOptions) =>
  options.dataDirectory ?? join(homedir(), ".aut");
