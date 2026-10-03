import { useEffect, type EffectCallback } from "react";

/** Work a component does once when it mounts, undone by its cleanup when it unmounts. */
export function useMountEffect(effect: EffectCallback): void {
  useEffect(effect, []);
}
