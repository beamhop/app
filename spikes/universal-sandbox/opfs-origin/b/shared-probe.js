// SharedWorker capability probe: could one shared kernel serve all tabs?
onconnect = (e) => {
  e.ports[0].postMessage({
    typeofWorker: typeof Worker,
    hasCreateSyncAccessHandle: typeof FileSystemFileHandle !== 'undefined' && 'createSyncAccessHandle' in FileSystemFileHandle.prototype,
    hasStorageGetDirectory: !!(navigator.storage && navigator.storage.getDirectory),
    crossOriginIsolated: self.crossOriginIsolated,
  });
};
