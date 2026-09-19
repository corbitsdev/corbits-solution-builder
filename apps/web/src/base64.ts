/**
 * `btoa(String.fromCharCode(...bytes))` blows the call stack on a
 * multi-megabyte buffer (`String.fromCharCode`'s spread puts one argument on
 * the stack per byte). Chunking keeps every call small regardless of input
 * size.
 */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}
