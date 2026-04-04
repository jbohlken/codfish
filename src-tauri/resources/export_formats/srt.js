// @name SRT
// @ext srt
//
// SubRip subtitle format.
// Captions input: [{ index, start, end, lines, speaker }]
// start/end are in seconds (float).

function transform(captions) {
  return captions.map(function (c, i) {
    return (i + 1) + '\n'
      + ts(c.start) + ' --> ' + ts(c.end) + '\n'
      + c.lines.join('\n') + '\n';
  }).join('\n');
}

function ts(s) {
  var h  = Math.floor(s / 3600);
  var m  = Math.floor((s % 3600) / 60);
  var sc = Math.floor(s % 60);
  var ms = Math.round((s % 1) * 1000);
  return pad(h) + ':' + pad(m) + ':' + pad(sc) + ',' + String(ms).padStart(3, '0');
}

function pad(n) { return String(n).padStart(2, '0'); }
