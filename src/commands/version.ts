import { VERSION } from '../constants';

// Bare version, like `npm --version`, so scripts need not parse it.
export function versionCommand(): void {
  console.log(VERSION);
}
