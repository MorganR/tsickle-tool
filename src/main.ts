#!/usr/bin/env node

import * as fs from "fs";
import minimist from "minimist";
import * as path from "path";
import * as ts from "typescript";
import * as tsickle from "tsickle";

/** Tsickle-specific settings. */
export interface Settings {
  /** Base module name to use for the root directory in goog.module exports. */
  module?: string;
  /** key;value module renames. */
  moduleRenames: Map<string, string>;
  /** Enable verbose debug logging. */
  verbose?: boolean;
}

function help() {
  console.error(`tsickle [tsickle options] -- [tsc options]

example:
  tsickle --module="my.goog.module" -- -p project/root

tsickle flags are:
  --module, m           Base module name to use for the root directory in goog.module exports.
  --module_renames, mr  key/value pair module renames. Can be specified multiple times.
  --verbose             Enables verbose debug-logging.
`);
}

/**
 * Parses the command-line arguments, extracting the tsickle settings and
 * the arguments to pass on to tsc.
 */
function loadSettingsFromArgs(args: string[]): {
  settings: Settings;
  tscArgs: string[];
} {
  const settings: Settings = {
    moduleRenames: new Map<string, string>(),
  };
  const parsedArgs = minimist(args);
  for (const flag of Object.keys(parsedArgs)) {
    switch (flag) {
      case "h":
      case "help":
        help();
        process.exit(0);
      case "m":
      case "module":
        settings.module = parsedArgs[flag];
        break;
      case "mr":
      case "module_renames":
        const [key, value] = parsedArgs[flag].split("/");
        settings.moduleRenames.set(key, value);
        break;
      case "v":
      case "verbose":
        settings.verbose = true;
        break;
      case "_":
        // This is part of the minimist API, and holds args after the '--'.
        break;
      default:
        console.error(`unknown flag '--${flag}'`);
        help();
        process.exit(1);
    }
  }
  // Arguments after the '--' arg are arguments to tsc.
  const tscArgs = parsedArgs["_"];
  return { settings, tscArgs };
}

/**
 * Determine the lowest-level common parent directory of the given list of files.
 */
export function getCommonParentDirectory(fileNames: string[]): string {
  const pathSplitter = /[\/\\]+/;
  const commonParent = fileNames[0].split(pathSplitter);
  for (let i = 1; i < fileNames.length; i++) {
    const thisPath = fileNames[i].split(pathSplitter);
    let j = 0;
    while (thisPath[j] === commonParent[j]) {
      j++;
    }
    commonParent.length = j; // Truncate without copying the array
  }
  if (commonParent.length === 0) {
    return "/";
  } else {
    return commonParent.join(path.sep);
  }
}

/**
 * Loads the tsconfig.json from a directory. May throw if an error occurs.
 *
 * @param args tsc command-line arguments.
 */
function loadTscConfig(args: string[]): ts.ParsedCommandLine {
  // Gather tsc options/input files from command line.
  const cmd = ts.parseCommandLine(args);
  if (cmd.errors.length > 0) {
    throw new Error(
      "Could not parse command line args: " +
        ts.formatDiagnostics(cmd.errors, ts.createCompilerHost(cmd.options))
    );
  }

  // Store any files requested directly from the command line.
  const filesFromCmdline = cmd.fileNames;

  // Read further settings from tsconfig.json.
  const projectDir = cmd.options.project || ".";
  let configFileName = ts.findConfigFile(projectDir, ts.sys.fileExists);
  if (!configFileName) {
    throw new Error(`Could not find tsconfig.json on path ${projectDir}.`);
  }
  // Make it absolute.
  configFileName = path.resolve(configFileName);

  const { config: json, error } = ts.readConfigFile(
    configFileName,
    ts.sys.readFile
  );
  if (error) {
    throw new Error(
      "error reading tsconfig.json: " +
        ts.formatDiagnostic(error, ts.createCompilerHost(cmd.options))
    );
  }

  const finalCmd = ts.parseJsonConfigFileContent(
    json,
    ts.sys,
    projectDir,
    cmd.options,
    configFileName,
    undefined,
    undefined,
    undefined,
    cmd.watchOptions
  );
  if (finalCmd.errors.length > 0) {
    throw new Error(
      "Could not parse tsconfig.json: " +
        ts.formatDiagnostics(
          finalCmd.errors,
          ts.createCompilerHost(cmd.options)
        )
    );
  }

  if (filesFromCmdline.length > 0) {
    finalCmd.fileNames = filesFromCmdline;
  }
  return finalCmd;
}

/** Verifies that Tsickle requirements for the TS Config are met. Throws if not. */
function verifyTsickleRequirements(config: ts.ParsedCommandLine) {
  if (config.options.module !== ts.ModuleKind.CommonJS) {
    // This is not an upstream TypeScript diagnostic, therefore it does not go
    // through the diagnostics array mechanism.
    throw new Error(
      "tsickle converts TypeScript modules to Closure modules via CommonJS internally. " +
        'Set tsconfig.js "module": "commonjs"'
    );
  }
}

/**
 * Compiles TypeScript code into Closure-compiler-ready JS.
 */
export function toClosureJS(
  options: ts.CompilerOptions,
  fileNames: string[],
  settings: Settings,
  writeFile: ts.WriteFileCallback
): tsickle.EmitResult {
  // Use absolute paths to determine what files to process since files may be imported using
  // relative or absolute paths
  const absoluteFileNames = fileNames.map((i) => path.resolve(i));

  const compilerHost = ts.createCompilerHost(options);
  const program = ts.createProgram(absoluteFileNames, options, compilerHost);
  const filesToProcess = new Set(absoluteFileNames);
  const rootModulePath = options.rootDir
    ? path.resolve(options.rootDir)
    : getCommonParentDirectory(absoluteFileNames);
  if (settings.verbose) {
    console.log(`Root module path: ${rootModulePath}`);
  }

  const transformerHost: tsickle.TsickleHost = {
    rootDirsRelative: (f: string) => f,
    shouldSkipTsickleProcessing: (fileName: string) => {
      return !filesToProcess.has(path.resolve(fileName));
    },
    shouldIgnoreWarningsForPath: (_fileName: string) => false,
    pathToModuleName: (context, fileName) => {
      const defaultName = tsickle.pathToModuleName(
        rootModulePath,
        context,
        fileName
      );
      if (settings.verbose) {
        console.log(`Default module name: ${defaultName}`);
      }
      // Only update the module for files we are compiling, otherwise this affects other things
      // like node modules. Paths we're compiling should be absolute paths or relative paths
      // starting with "./".
      if (
        settings.module &&
        (path.isAbsolute(fileName) || fileName.startsWith("./"))
      ) {
        const updatedName = settings.module + "." + defaultName;
        if (settings.verbose) {
          console.log(`Updating to: ${updatedName}`);
        }
        return updatedName;
      }
      // Also check for literal renames.
      for (const [key, value] of settings.moduleRenames) {
        if (defaultName === key) {
          if (settings.verbose) {
            console.log(`Renaming module ${key} to ${value}`);
          }
          return value;
        }
      }
      return defaultName;
    },
    fileNameToModuleId: (fileName) => path.relative(rootModulePath, fileName),
    googmodule: true,
    transformDecorators: true,
    transformTypesToClosure: true,
    typeBlackListPaths: new Set(),
    untyped: false,
    logWarning: (warning) =>
      console.error(ts.formatDiagnostics([warning], compilerHost)),
    options,
    moduleResolutionHost: compilerHost,
    generateExtraSuppressions: true,
  };
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length > 0) {
    return {
      tsMigrationExportsShimFiles: new Map(),
      diagnostics,
      modulesManifest: new tsickle.ModulesManifest(),
      externs: {},
      emitSkipped: true,
      emittedFiles: [],
    };
  }
  return tsickle.emit(program, transformerHost, writeFile);
}

function main(args: string[]): number {
  const { settings, tscArgs } = loadSettingsFromArgs(args);

  let config: ts.ParsedCommandLine;
  try {
    config = loadTscConfig(tscArgs);
  } catch (e) {
    console.error(`Error loading ts config: ${e}`);
    return 1;
  }

  try {
    verifyTsickleRequirements(config);
  } catch (e) {
    console.error(`TS config failed Tsickle validation: ${e}`);
    return 1;
  }

  // Run tsickle+TSC to convert inputs to Closure JS files.
  const result = toClosureJS(
    config.options,
    config.fileNames,
    settings,
    (filePath: string, contents: string) => {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, contents, { encoding: "utf-8" });
    }
  );
  if (result.diagnostics.length) {
    console.error(
      ts.formatDiagnostics(
        result.diagnostics,
        ts.createCompilerHost(config.options)
      )
    );
    return 1;
  }
  return 0;
}

// CLI entry point
if (require.main === module) {
  process.exit(main(process.argv.splice(2)));
}
