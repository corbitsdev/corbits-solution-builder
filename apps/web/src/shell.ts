/** True inside the Tauri webview, false for a plain browser or SSR. */
export const inShell = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
