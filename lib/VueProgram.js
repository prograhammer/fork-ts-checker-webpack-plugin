"use strict";
var fs = require("fs");
var path = require("path");
var ts = require("typescript");
// @ts-ignore: Missing type definitions
var vueTemplateCompiler = require("vue-template-compiler");
var VueProgram = /** @class */ (function () {
    function VueProgram() {
    }
    VueProgram.loadProgramConfig = function (configFile) {
        var extraExtensions = ['vue'];
        var parseConfigHost = {
            fileExists: ts.sys.fileExists,
            readFile: ts.sys.readFile,
            useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
            readDirectory: function (rootDir, extensions, excludes, includes, depth) {
                return ts.sys.readDirectory(rootDir, extensions.concat(extraExtensions), excludes, includes, depth);
            }
        };
        var parsed = ts.parseJsonConfigFileContent(
        // Regardless of the setting in the tsconfig.json we want isolatedModules to be false
        Object.assign(ts.readConfigFile(configFile, ts.sys.readFile).config, { isolatedModules: false }), parseConfigHost, path.dirname(configFile));
        parsed.options.allowNonTsExtensions = true;
        return parsed;
    };
    /**
     * As parsing of component pad with new line, we have to add disable tslint on this empty content.
     */
    VueProgram.fixContentForTsLint = function (content) {
        var disableTsLint = '// tslint:disable\n';
        var enableTsLint = '// tslint:enable\n';
        content = content.replace(/(\s+?)$(\s*)(\s+?)$(\s*\S+)/m, disableTsLint + "$2" + enableTsLint + "$4");
        var enableTsLintIndex = content.indexOf(enableTsLint);
        if (enableTsLintIndex === -1) {
            content = content.replace(/^(\s+)(\S+)/, '$2');
        }
        return content;
    };
    /**
     * Since 99.9% of Vue projects use the wildcard '@/*', we only search for that in tsconfig CompilerOptions.paths.
     * The path is resolved with thie given substitution and includes the CompilerOptions.baseUrl (if given).
     * If no paths given in tsconfig, then the default substitution is '[tsconfig directory]/src'.
     * (This is a fast, simplified inspiration of what's described here: https://github.com/Microsoft/TypeScript/issues/5039)
     */
    VueProgram.resolveNonTsModuleName = function (moduleName, containingFile, basedir, options) {
        var baseUrl = options.baseUrl ? options.baseUrl : basedir;
        var pattern = options.paths ? options.paths['@/*'] : undefined;
        var substitution = pattern ? options.paths['@/*'][0].replace('*', '') : 'src';
        var isWildcard = moduleName.substr(0, 2) === '@/';
        var isRelative = !path.isAbsolute(moduleName);
        if (isWildcard) {
            moduleName = path.resolve(baseUrl, substitution, moduleName.substr(2));
        }
        else if (isRelative) {
            moduleName = path.resolve(path.dirname(containingFile), moduleName);
        }
        return moduleName;
    };
    VueProgram.createProgram = function (programConfig, basedir, files, watcher, oldProgram) {
        var _this = this;
        var host = ts.createCompilerHost(programConfig.options);
        var realGetSourceFile = host.getSourceFile;
        // We need a host that can parse Vue SFCs (single file components).
        host.getSourceFile = function (filePath, languageVersion, onError) {
            // first check if watcher is watching file - if not - check it's mtime
            if (!watcher.isWatchingFile(filePath)) {
                try {
                    var stats = fs.statSync(filePath);
                    files.setMtime(filePath, stats.mtime.valueOf());
                }
                catch (e) {
                    // probably file does not exists
                    files.remove(filePath);
                }
            }
            // get source file only if there is no source in files register
            if (!files.has(filePath) || !files.getData(filePath).source) {
                files.mutateData(filePath, function (data) {
                    data.source = realGetSourceFile(filePath, languageVersion, onError);
                });
            }
            var source = files.getData(filePath).source;
            // get typescript contents from Vue file
            if (source && filePath.substr(-4) === '.vue') {
                var sfcDescriptor = vueTemplateCompiler.parseComponent(source.text, { pad: 'line' });
                if (sfcDescriptor.script && sfcDescriptor.script.attrs && sfcDescriptor.script.attrs.lang == 'ts') {
                    if (sfcDescriptor.script && sfcDescriptor.script.src) {
                        sfcDescriptor.script.content = fs.readFileSync(path.join(filePath, '..', sfcDescriptor.script.src), 'utf8');
                    }
                    var parsed = _this.fixContentForTsLint(sfcDescriptor.script.content);
                    source = ts.createSourceFile(filePath, parsed, languageVersion, true);
                }
            }
            return source;
        };
        // We need a host with special module resolution for Vue files.
        host.resolveModuleNames = function (moduleNames, containingFile) {
            var resolvedModules = [];
            for (var _i = 0, moduleNames_1 = moduleNames; _i < moduleNames_1.length; _i++) {
                var moduleName = moduleNames_1[_i];
                // Try to use standard resolution.
                var result = ts.resolveModuleName(moduleName, containingFile, programConfig.options, {
                    fileExists: host.fileExists,
                    readFile: host.readFile
                });
                if (result.resolvedModule) {
                    resolvedModules.push(result.resolvedModule);
                }
                else {
                    // For non-ts extensions.
                    resolvedModules.push({
                        resolvedFileName: VueProgram.resolveNonTsModuleName(moduleName, containingFile, basedir, programConfig.options),
                        extension: '.ts'
                    });
                }
            }
            return resolvedModules;
        };
        return ts.createProgram(programConfig.fileNames, programConfig.options, host, oldProgram // re-use old program
        );
    };
    return VueProgram;
}());
module.exports = VueProgram;
