/*
 * Windows-safe File System Access wrapper for the archive page.
 * Historical source data can contain names that Windows rejects as file/folder
 * names (for example a driver name ending in a period). Normalize every name
 * passed through the File System Access API without changing the source data.
 */
(function installArchiveWindowsSafeNames() {
  const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

  function windowsSafeName(value) {
    let name = String(value ?? "")
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[. ]+$/g, "")
      .slice(0, 120)
      .replace(/[. ]+$/g, "");

    if (!name || name === "." || name === "..") name = "Unknown";
    if (RESERVED.test(name)) name = `_${name}`;
    return name;
  }

  function patchMethod(proto, methodName) {
    if (!proto || typeof proto[methodName] !== "function") return;
    const original = proto[methodName];
    if (original.__windowsSafeArchiveWrapped) return;

    const wrapped = function (name, ...args) {
      return original.call(this, windowsSafeName(name), ...args);
    };
    wrapped.__windowsSafeArchiveWrapped = true;
    proto[methodName] = wrapped;
  }

  patchMethod(window.FileSystemDirectoryHandle?.prototype, "getDirectoryHandle");
  patchMethod(window.FileSystemDirectoryHandle?.prototype, "getFileHandle");

  window.archiveWindowsSafeName = windowsSafeName;
})();
