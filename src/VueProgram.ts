import fs = require('fs');
import path = require('path');
import ts = require('typescript');
import FilesRegister = require('./FilesRegister');
import FilesWatcher = require('./FilesWatcher');
// @ts-ignore: Missing type definitions
import vueTemplateCompiler = require('vue-template-compiler');

class VueProgram {
  static loadProgramConfig(configFile: string) {
    const extraExtensions = ['vue'];

    const parseConfigHost: ts.ParseConfigHost = {
        fileExists: ts.sys.fileExists,
        readFile: ts.sys.readFile,
        useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
        readDirectory: (rootDir, extensions, excludes, includes, depth) => {
            return ts.sys.readDirectory(rootDir, extensions.concat(extraExtensions), excludes, includes, depth);
        }
    };

    const parsed = ts.parseJsonConfigFileContent(
      // Regardless of the setting in the tsconfig.json we want isolatedModules to be false
      Object.assign(ts.readConfigFile(configFile, ts.sys.readFile).config, { isolatedModules: false }),
      parseConfigHost,
      path.dirname(configFile)
    );

    parsed.options.allowNonTsExtensions = true;

    return parsed;
  }

  /**
   * As parsing of component pad with new line, we have to add disable tslint on this empty content.
   */
  public static fixContentForTsLint(content: string): string {
      const disableTsLint = '// tslint:disable\n'
      const enableTsLint = '// tslint:enable\n'
      content = content.replace(/(\s+?)$(\s*)(\s+?)$(\s*\S+)/m,
          `${disableTsLint}$2${enableTsLint}$4`)

      const enableTsLintIndex = content.indexOf(enableTsLint)
      if (enableTsLintIndex === -1) {
        content = content.replace(/^(\s+)(\S+)/, '$2')
      }

      return content
  }

  /**
   * Since 99.9% of Vue projects use the wildcard '@/*', we only search for that in tsconfig CompilerOptions.paths.
   * The path is resolved with thie given substitution and includes the CompilerOptions.baseUrl (if given).
   * If no paths given in tsconfig, then the default substitution is '[tsconfig directory]/src'.
   * (This is a fast, simplified inspiration of what's described here: https://github.com/Microsoft/TypeScript/issues/5039)
   */
  public static resolveNonTsModuleName(moduleName: string, containingFile: string, basedir: string, options: ts.CompilerOptions) {
    const baseUrl = options.baseUrl ? options.baseUrl : basedir;
    const pattern = options.paths ? options.paths['@/*'] : undefined;
    const substitution = pattern ? options.paths['@/*'][0].replace('*', '') : 'src';
    const isWildcard = moduleName.substr(0, 2) === '@/';
    const isRelative = !path.isAbsolute(moduleName);

    if (isWildcard) {
      moduleName = path.resolve(baseUrl, substitution, moduleName.substr(2));
    } else if (isRelative) {
      moduleName = path.resolve(path.dirname(containingFile), moduleName);
    }

    return moduleName;
  }

  static createProgram(
    programConfig: ts.ParsedCommandLine,
    basedir: string,
    files: FilesRegister,
    watcher: FilesWatcher,
    oldProgram: ts.Program
  ) {
    const host = ts.createCompilerHost(programConfig.options);
    const realGetSourceFile = host.getSourceFile;

    // We need a host that can parse Vue SFCs (single file components).
    host.getSourceFile = (filePath, languageVersion, onError) => {
      // first check if watcher is watching file - if not - check it's mtime
      if (!watcher.isWatchingFile(filePath)) {
        try {
          const stats = fs.statSync(filePath);

          files.setMtime(filePath, stats.mtime.valueOf());
        } catch (e) {
          // probably file does not exists
          files.remove(filePath);
        }
      }

      // get source file only if there is no source in files register
      if (!files.has(filePath) || !files.getData(filePath).source) {
        files.mutateData(filePath, (data) => {
          data.source = realGetSourceFile(filePath, languageVersion, onError);
        });
      }

      let source = files.getData(filePath).source;

      // get typescript contents from Vue file
      if (source && filePath.substr(-4) === '.vue') {
        const sfcDescriptor = vueTemplateCompiler.parseComponent(source.text, {pad: 'line'});
        if (sfcDescriptor.script && sfcDescriptor.script.attrs && sfcDescriptor.script.attrs.lang == 'ts') {
          if (sfcDescriptor.script && sfcDescriptor.script.src) {
            sfcDescriptor.script.content = fs.readFileSync(path.join(filePath, '..', sfcDescriptor.script.src), 'utf8')
          }
          const parsed = this.fixContentForTsLint(sfcDescriptor.script.content)
          source = ts.createSourceFile(filePath, parsed, languageVersion, true);
        }
      }

      return source;
    };

    // We need a host with special module resolution for Vue files.
    host.resolveModuleNames = (moduleNames, containingFile) => {
      const resolvedModules: ts.ResolvedModule[] = [];

      for (const moduleName of moduleNames) {
        // Try to use standard resolution.
        const result = ts.resolveModuleName(moduleName, containingFile, programConfig.options, {
          fileExists: host.fileExists,
          readFile: host.readFile
        });

        if (result.resolvedModule) {
          resolvedModules.push(result.resolvedModule);
        } else {
          // For non-ts extensions.
          resolvedModules.push({
            resolvedFileName: VueProgram.resolveNonTsModuleName(moduleName, containingFile, basedir, programConfig.options),
            extension: '.ts'
          } as ts.ResolvedModuleFull);
        }
      }

      return resolvedModules;
    };

    return ts.createProgram(
      programConfig.fileNames,
      programConfig.options,
      host,
      oldProgram // re-use old program
    );
  }
}

export = VueProgram;
