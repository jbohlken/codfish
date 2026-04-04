// @name WebVTT
// @ext vtt
//
// Web Video Text Tracks format.
// Captions input: [{ index, start, end, lines, speaker }]
// start/end are in seconds (float).

function transform(captions) {
  var blocks = captions.map(function (c, i) {
    return (i + 1) + '\n'
      + ts(c.start) + ' --> ' + ts(c.end) + '\n'
      + c.lines.join('\n');
  }).join('\n\n');
  return 'WEBVTT\n\n' + blocks + '\n';
}

function ts(s) {
  var h  = Math.floor(s / 3600);
  var m  = Math.floor((s % 3600) / 60);
  var sc = Math.floor(s % 60);
  var ms = Math.round((s % 1) * 1000);
  // VTT uses a dot before milliseconds; SRT uses a comma
  return pad(h) + ':' + pad(m) + ':' + pad(sc) + '.' + String(ms).padStart(3, '0');
}

function pad(n) { return String(n).padStart(2, '0'); }
