import { VERSION } from '../constants';

// Prints the bare version, the way `npm --version` does, so scripts can read
// it without parsing. `help` still prints the decorated "workler <version>".
export function versionCommand(): void {
  console.log(VERSION);
}
