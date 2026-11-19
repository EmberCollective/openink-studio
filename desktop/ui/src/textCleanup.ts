// 从 PDF / Word 复制来的中文常夹着多余空格，例如「本册共 6个单元」。
// 这里只清理明确属于排版噪音的单空格，保留英文单词之间的空格。
const CJK = "\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF";
const PUNCT = "，。、；：！？（）《》「」『』【】…—～·";
const DIGIT = "0-9０-９";
// 中文里夹的空格可能是中文输入法打出的全角空格（U+3000），也一并清掉；
// 行首缩进仍保留（下面规则都要求前后有字符）。
const ANY_SPACE = "[ \\u00A0\\u3000]";

/**
 * 去掉句中夹着的单空格：
 * - 中文 + 空格 + 中文（含全角空格，如「标题　图　建议」）
 * - 中文 + 空格 + 数字、数字 + 空格 + 中文（含全角空格）
 * - 中文标点两侧的空格（含全角空格）
 * - 行尾空格
 * 英文单词之间的空格（如 Get ready）保持不动；行首缩进也保持不动。
 */
export function cleanStraySpaces(input: string): { text: string; removed: number } {
  const rules = [
    new RegExp(`(?<=[${CJK}])${ANY_SPACE}(?=[${CJK}])`, "g"),
    new RegExp(`(?<=[${CJK}])${ANY_SPACE}(?=[${DIGIT}])`, "g"),
    new RegExp(`(?<=[${DIGIT}])${ANY_SPACE}(?=[${CJK}])`, "g"),
    new RegExp(`(?<=[${PUNCT}])${ANY_SPACE}`, "g"),
    new RegExp(`${ANY_SPACE}(?=[${PUNCT}])`, "g"),
    /[ \u00A0]+$/gm,
  ];
  let text = input;
  for (const rule of rules) text = text.replace(rule, "");
  return { text, removed: input.length - text.length };
}
