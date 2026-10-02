#!/usr/bin/env node
import { install, parseArguments, HELP } from '../src/installer.mjs';

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) process.stdout.write(HELP);
  else {
    const result = await install(options);
    process.stdout.write(`${result.existing ? 'Chat2Local is already installed' : 'Installed Chat2Local'} ${result.version} in ${result.path}.\n`);
    process.stdout.write('Open Chat2Local and enter your tunnel ID and runtime key under ChatGPT connection.\n');
  }
} catch (error) {
  // Do not print raw network failures, manifest values, credentials, or stack traces.
  process.stderr.write(`Chat2Local: ${error.publicMessage ?? 'Installation failed. Check the release, destination permissions, and network, then try again.'}\n`);
  process.exitCode = 1;
}
