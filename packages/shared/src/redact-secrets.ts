/**
 * 密钥/令牌脱敏：Memory Digest 与 /distill 等把对话内容交给 LLM 或写盘前的共同安全边界。
 * 宁可误伤也不能把 secret 泄露进日志或技能文件。
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/gu, "[REDACTED_KEY]")
    .replace(/\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]{16,}\b/gu, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]{16,}\b/giu, "Bearer [REDACTED]")
    .replace(/\b[A-Fa-f0-9]{32,}\b/gu, "[REDACTED_HEX]")
    .replace(/\b(?:xoxb|xoxp)-[A-Za-z0-9-]{10,}\b/gu, "[REDACTED_SLACK_TOKEN]");
}
