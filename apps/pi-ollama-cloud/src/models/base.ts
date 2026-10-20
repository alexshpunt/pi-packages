// The cloud extension always targets ollama.com; local Ollama daemons (typically
// pointed at via OLLAMA_API_BASE for the local CLI) are a different product and
// must not silently redirect cloud requests. Warn once at module load if the
// env var looks like a non-cloud target so the misconfiguration is visible.
const CLOUD_BASE_URL = "https://ollama.com";
const envBase = typeof process !== "undefined" ? process.env?.OLLAMA_API_BASE : undefined;
if (envBase) {
  // Warn when OLLAMA_API_BASE is set to anything other than the cloud host.
  // Parse the URL so lookalikes (e.g. https://ollama.com.evil.com) are not
  // mistaken for the cloud base. OLLAMA_API_BASE is otherwise ignored: this
  // extension always targets CLOUD_BASE_URL.
  let isCloudBase = false;
  try {
    const url = new URL(envBase);
    isCloudBase = url.protocol === "https:" && url.hostname === "ollama.com";
  } catch {
    // Invalid URL: not the cloud base.
  }
  if (!isCloudBase) {
    console.warn(
      `[pi-ollama-cloud] Ignoring OLLAMA_API_BASE=${envBase}; ` +
        `this extension always targets ${CLOUD_BASE_URL}. ` +
        `Unset OLLAMA_API_BASE (or set it to the cloud URL) to silence this warning.`,
    );
  }
}
export const OLLAMA_BASE = CLOUD_BASE_URL.replace(/\/+$/, "");
