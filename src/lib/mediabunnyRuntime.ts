/**
 * Shared lazy loader for mediabunny + the extension decoders (ProRes, AC-3).
 * Every production consumer (mediaProbe, peaksMediabunny, filmstrip) MUST get
 * mediabunny through this module: the adversarial review caught that decoder
 * registration originally lived only in the dev spike chunk, so production
 * canDecode() would have returned false for ProRes/AC-3 — silently disabling
 * the filmstrip and waveform for exactly the formats this project adopted
 * mediabunny for.
 *
 * Registration is idempotent per module instance (one shared chunk), the
 * decoders are tiny relative to their WASM payloads which only initialize on
 * first use, and everything stays out of the startup path — the chunk loads on
 * the first probe/peaks/thumb request.
 */

let loaded: Promise<typeof import("mediabunny")> | null = null;

export function loadMediabunny(): Promise<typeof import("mediabunny")> {
  loaded ??= (async () => {
    const [mediabunny, prores, ac3] = await Promise.all([
      import("mediabunny"),
      import("@mediabunny/prores"),
      import("@mediabunny/ac3"),
    ]);
    prores.registerProresDecoder();
    ac3.registerAc3Decoder();
    return mediabunny;
  })();
  return loaded;
}
