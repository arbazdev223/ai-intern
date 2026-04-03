function estimateTokens(text) {
  if (!text) return 0;
  // heuristic: 1 token ~= 4 chars
  return Math.ceil(String(text).length / 4);
}

function estimateMessages(messages) {
  if (!messages) return 0;
  if (!Array.isArray(messages)) return estimateTokens(String(messages));
  let total = 0;
  for (const msg of messages) {
    if (!msg) continue;
    if (typeof msg === "string") total += estimateTokens(msg);
    else if (msg && typeof msg.content === "string") total += estimateTokens(msg.content);
    else total += estimateTokens(JSON.stringify(msg));
  }
  return total;
}

module.exports = { estimateTokens, estimateMessages };
