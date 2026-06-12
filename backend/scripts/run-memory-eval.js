const { runMemoryEvals } = require('../services/memory/memory-evals');

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [name, inlineValue] = arg.includes('=') ? arg.split(/=(.*)/s) : [arg, undefined];
    const value = inlineValue ?? argv[index + 1];

    if (name === '--memory-on') {
      options.memoryOn = inlineValue === undefined || inlineValue !== 'false';
      if (inlineValue === undefined) index += 1;
    } else if (name === '--memory-off') {
      options.memoryOn = inlineValue === 'true';
      if (inlineValue === undefined) index += 1;
    } else if (name === '--eval-file') {
      options.evalFile = value;
      if (inlineValue === undefined) index += 1;
    } else if (name === '--name') {
      options.name = value;
      if (inlineValue === undefined) index += 1;
    } else if (name === '--json') {
      options.json = true;
    } else if (name === '--help' || name === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown memory eval argument: ${arg}`);
    }
  }

  if (options.memoryOn === undefined) options.memoryOn = true;
  return options;
}

function printHelp() {
  console.log(`Usage:
  node backend/scripts/run-memory-eval.js [--memory-on] [--memory-off] [--eval-file path] [--name name] [--json]

Options:
  --memory-on    Build prompts with August memory enabled. Default.
  --memory-off   Build prompts with August memory disabled.
  --eval-file    Path to a JSON eval file.
  --name         Name of a JSON file under evals/memory.
  --json         Print machine-readable JSON only.
`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const result = runMemoryEvals(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    console.log(`memory evals: ${result.passed}/${result.total} passed`);
    for (const item of result.results) {
      const status = item.passed ? 'PASS' : 'FAIL';
      console.log(`${status} ${item.id} (${item.matchCounts.memoryOn}/${item.expectedTokens.length} matches, +${item.injectedMemoryLength} chars)`);
      if (!item.passed) {
        console.log(`  expected: ${item.expectedTokens.join(', ')}`);
        console.log(`  found: ${item.matches.memoryOn.join(', ') || 'none'}`);
      }
    }
  }

  if (!result.ok) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
