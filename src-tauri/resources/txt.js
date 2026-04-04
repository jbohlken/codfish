// @name Plain Text
// @ext txt
//
// Plain text transcript — caption text only, no timestamps.
// Captions input: [{ index, start, end, lines, speaker }]

function transform(captions) {
  return captions.map(function (c) {
    return c.lines.join(' ');
  }).join(' ') + '\n';
}
