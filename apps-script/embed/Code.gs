/**
 * Mushy Edit — embed breakdown pictures.
 *
 * The web app writes each picture as =IMAGE(<link-shared Drive file>) because
 * the Sheets API can't put image bytes in a cell. This function swaps those
 * for images stored inside the Sheet itself, so the app can then delete the
 * link-shared Drive files.
 *
 * Deployed ONCE as an API executable inside the "Ray AI" GCP project (the
 * same project as the web app's OAuth client). The web app calls it with
 * scripts.run using the signed-in user's own token, so it runs as that user —
 * users never see, copy, or install this script. Source of truth:
 * apps-script/embed/ in the mushy-edit repo.
 *
 * cells: [{ sheetId, row, col, url }] — row/col are 0-based.
 * Returns one boolean per cell: true if that cell now holds an embedded image.
 */
function embedImages(spreadsheetId, cells) {
  var ss = SpreadsheetApp.openById(spreadsheetId);
  var sheets = {};
  ss.getSheets().forEach(function (s) { sheets[s.getSheetId()] = s; });

  cells.forEach(function (c) {
    var sh = sheets[c.sheetId];
    if (!sh) return;
    try {
      var img = SpreadsheetApp.newCellImage().setSourceUrl(c.url).build();
      sh.getRange(c.row + 1, c.col + 1).setValue(img);
    } catch (e) {
      // Leave the =IMAGE() link in place; the app keeps that Drive file.
    }
  });
  SpreadsheetApp.flush();

  // Read back what actually landed, one read per sheet.
  var grids = {};
  return cells.map(function (c) {
    var sh = sheets[c.sheetId];
    if (!sh) return false;
    if (!grids[c.sheetId]) grids[c.sheetId] = sh.getDataRange().getValues();
    var v = (grids[c.sheetId][c.row] || [])[c.col];
    return !!v && typeof v === 'object' && v.valueType === SpreadsheetApp.ValueType.IMAGE;
  });
}
