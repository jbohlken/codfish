// Media file-type lists. A leaf module (no imports) so both lib/project and
// store/app can use them — lib/project imports the store, so the store can't
// pull these from lib/project without a cycle.

export const VIDEO_EXTS = ["mp4", "mov", "webm"];
export const AUDIO_EXTS = ["mp3", "wav", "aac", "flac", "ogg"];

/** Whether a media path is audio-only (by extension). */
export function isAudioPath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return AUDIO_EXTS.includes(ext);
}
