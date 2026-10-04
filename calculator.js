const MAX_EXPRESSION_LENGTH = 128;
const MAX_TOKENS = 64;
const MAX_RESULT = 1e100;

function evaluateCalculatorExpression(input) {
  const expression = String(input || "")
    .trim()
    .replace(/[−–]/g, "-")
    .replace(/[×·]/g, "*")
    .replace(/[÷:]/g, "/")
    .replace(/,/g, ".");
  if (!expression || expression.length > MAX_EXPRESSION_LENGTH) return null;

  const tokens = [];
  const tokenPattern = /\s*(?:(\d+(?:\.\d*)?|\.\d+)|([()+\-*/^%]))/gy;
  let position = 0;
  while (position < expression.length) {
    if (!expression.slice(position).trim()) break;
    tokenPattern.lastIndex = position;
    const match = tokenPattern.exec(expression);
    if (!match) return null;
    tokens.push(match[1] === undefined ? match[2] : Number(match[1]));
    if (tokens.length > MAX_TOKENS) return null;
    position = tokenPattern.lastIndex;
  }

  let cursor = 0;
  const peek = () => tokens[cursor];
  const take = () => tokens[cursor++];
  const checked = value => Number.isFinite(value) && Math.abs(value) <= MAX_RESULT ? value : NaN;

  function parsePrimary() {
    const token = take();
    if (typeof token === "number") return token;
    if (token !== "(") return NaN;
    const value = parseExpression();
    if (take() !== ")") return NaN;
    return value;
  }

  function parsePercent() {
    let value = parsePrimary();
    while (peek() === "%") {
      take();
      value = checked(value / 100);
    }
    return value;
  }

  function parsePower() {
    const base = parsePercent();
    if (peek() !== "^") return base;
    take();
    return checked(base ** parseUnary());
  }

  function parseUnary() {
    if (peek() === "+") { take(); return parseUnary(); }
    if (peek() === "-") { take(); return checked(-parseUnary()); }
    return parsePower();
  }

  function parseTerm() {
    let value = parseUnary();
    while (peek() === "*" || peek() === "/") {
      const operator = take();
      const right = parseUnary();
      if (operator === "/" && right === 0) return NaN;
      value = checked(operator === "*" ? value * right : value / right);
    }
    return value;
  }

  function parseExpression() {
    let value = parseTerm();
    while (peek() === "+" || peek() === "-") {
      const operator = take();
      const right = parseTerm();
      value = checked(operator === "+" ? value + right : value - right);
    }
    return value;
  }

  const result = parseExpression();
  if (cursor !== tokens.length || !Number.isFinite(result)) return null;
  return Object.is(result, -0) ? 0 : result;
}

module.exports = { evaluateCalculatorExpression };
