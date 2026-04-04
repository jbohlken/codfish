// @name JSON (Raw)
// @ext json
//
// Raw caption data — useful as input to external tools or scripts.
// Captions input: [{ index, start, end, lines, speaker }]
// start/end are in seconds (float).

function transform(captions) {
  return JSON.stringify(captions, null, 2);
}
