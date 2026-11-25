self.onmessage = () => {
  const out = {};
  try { new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])); out.wasm = 'ok'; } catch (e) { out.wasm = 'blocked: ' + e.name; }
  try { out.eval = 'ok ' + (0, eval)('1+1'); } catch (e) { out.eval = 'blocked: ' + e.name; }
  postMessage(out);
};
