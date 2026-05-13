/**
 * 将 A1 风格公式中的相对行号整体平移 deltaRow（用于从模板行复制到下方行）。
 * 已锁定行（如 A$5、$A$5 中的行号）不修改。
 */
function shiftFormulaRowRefs(formula, deltaRow) {
  if (typeof formula !== "string" || !formula.startsWith("=") || !deltaRow) return formula;

  return formula.replace(/(\$?)([A-Za-z]{1,3})(\$?)(\d+)/g, (full, colLock, colLetters, rowLock, rowStr) => {
    if (rowLock === "$") return full;
    const row = parseInt(rowStr, 10);
    if (!Number.isFinite(row)) return full;
    return `${colLock}${colLetters}${rowLock}${row + deltaRow}`;
  });
}

module.exports = { shiftFormulaRowRefs };
