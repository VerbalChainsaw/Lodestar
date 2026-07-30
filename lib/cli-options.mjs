import { LodestarError } from "./errors.mjs";

function missingValue(flag) {
  return new LodestarError(
    "invalid-option",
    `Option ${flag} requires a value`,
    {
      detail: {
        option: flag,
        reason: "value-required",
      },
    },
  );
}

export function optionValues(args, flag) {
  const output = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== flag) continue;
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw missingValue(flag);
    }
    output.push(value);
    index += 1;
  }
  return output;
}

export function optionValue(args, flag, fallback = undefined) {
  return optionValues(args, flag).at(-1) ?? fallback;
}

export function validateValueOptions(args, flags) {
  for (const flag of flags) optionValues(args, flag);
}

export function validateKnownOptions(
  args,
  {
    command,
    valueOptions = [],
    booleanOptions = [],
  } = {},
) {
  const values = new Set(valueOptions);
  const booleans = new Set(booleanOptions);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) continue;
    if (values.has(argument)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw missingValue(argument);
      }
      index += 1;
      continue;
    }
    if (booleans.has(argument)) continue;
    throw new LodestarError(
      "invalid-option",
      `Option ${argument} is not valid for ${command}`,
      {
        detail: {
          command,
          option: argument,
          reason: "unknown-for-command",
        },
      },
    );
  }
}

export function positionalValues(args, valueOptions = []) {
  const options = new Set(valueOptions);
  const output = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (options.has(argument)) {
      index += 1;
    } else if (!argument.startsWith("--")) {
      output.push(argument);
    }
  }
  return output;
}
