'use strict';
// In-memory TypeScript program over the fake fs: parse + bind + type-check.
const fs = require('fs');
const libDir = '/node_modules/typescript/lib';
module.exports = function check(ts, fileName, source) {
  const options = { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext, strict: true, noEmit: true, lib: ['lib.es2020.d.ts'], types: [] };
  const read = (f) => (f === fileName ? source : fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : undefined);
  const host = {
    getSourceFile: (name, langVer) => { const text = read(name); return text === undefined ? undefined : ts.createSourceFile(name, text, langVer, true); },
    getDefaultLibFileName: () => libDir + '/lib.es2020.d.ts',
    getDefaultLibLocation: () => libDir,
    writeFile() {},
    getCurrentDirectory: () => '/app',
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (f) => read(f) !== undefined,
    readFile: read,
    directoryExists: (d) => fs.existsSync(d),
    getDirectories: () => [],
  };
  const program = ts.createProgram([fileName], options, host);
  const diags = ts.getPreEmitDiagnostics(program);
  return diags.map((d) => ({ code: d.code, file: d.file ? d.file.fileName : null, msg: ts.flattenDiagnosticMessageText(d.messageText, '\n').slice(0, 200) }));
};
