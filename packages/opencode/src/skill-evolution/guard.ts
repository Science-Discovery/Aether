import fs from "fs/promises"
import path from "path"
import { MAX_SCAN_FILES, MAX_TOTAL_SIZE_BYTES, MAX_FILE_SIZE_BYTES } from "./constants"

export type Severity = "safe" | "caution" | "dangerous"

export interface Issue {
  file: string
  line: number
  pattern: string
  severity: Severity
  description: string
}

export interface ScanResult {
  issues: Issue[]
  worstSeverity: Severity
}

interface Pattern {
  regex: RegExp
  severity: Severity
  description: string
  label: string
}

// Invisible/zero-width character set (Unicode escapes to avoid literal control chars in source)
// Covers U+200B-U+200F, U+202A-U+202E, U+2060-U+206F, U+FEFF
const INVISIBLE_CHARS_RE = new RegExp(
  "[​-‏‪-‮⁠-⁯﻿]",
)

const PATTERNS: Pattern[] = [
  // Data exfiltration
  {
    regex: /\b(curl|wget)\b.*(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|AWS_SECRET|password|token|secret)/i,
    severity: "dangerous",
    description: "Potential data exfiltration via curl/wget with credentials",
    label: "data-exfil",
  },
  // Prompt injection
  {
    regex: /ignore\s+(all\s+)?(previous|prior|above|system)\s+instructions?/i,
    severity: "dangerous",
    description: "Prompt injection attempt detected",
    label: "prompt-injection",
  },
  {
    regex: /disregard\s+(all\s+)?(previous|prior|above|system)\s+instructions?/i,
    severity: "dangerous",
    description: "Prompt injection attempt detected",
    label: "prompt-injection",
  },
  // Destructive operations
  {
    regex: /\brm\s+-[^\s]*r[^\s]*f\b|\brm\s+-[^\s]*f[^\s]*r\b/,
    severity: "dangerous",
    description: "Destructive rm -rf operation",
    label: "destructive",
  },
  {
    regex: /\bdd\b.*\bof=/,
    severity: "dangerous",
    description: "Potentially destructive dd command",
    label: "destructive",
  },
  // Persistence
  {
    regex: /\bcrontab\s+-[el]\b|\bcrontab\b.*\/etc\/cron/,
    severity: "dangerous",
    description: "Writing to crontab for persistence",
    label: "persistence",
  },
  {
    regex: /\/etc\/sudoers/,
    severity: "dangerous",
    description: "Modifying sudoers file",
    label: "persistence",
  },
  {
    regex: /~\/\.ssh\/(authorized_keys|config)\b/,
    severity: "dangerous",
    description: "Modifying SSH authorized_keys or config",
    label: "persistence",
  },
  // Supply chain
  {
    regex: /\bcurl\b[^|]*\|\s*(bash|sh)\b/,
    severity: "dangerous",
    description: "curl pipe to shell (supply chain risk)",
    label: "supply-chain",
  },
  {
    regex: /\bwget\b[^|]*\|\s*(bash|sh)\b/,
    severity: "dangerous",
    description: "wget pipe to shell (supply chain risk)",
    label: "supply-chain",
  },
  {
    regex: /\/dev\/tcp\//,
    severity: "dangerous",
    description: "Potential reverse shell via /dev/tcp",
    label: "supply-chain",
  },
  // Hardcoded credentials
  {
    regex: /(?:api[_-]?key|secret[_-]?key|private[_-]?key|access[_-]?token)\s*[:=]\s*["']?[A-Za-z0-9+/]{20,}["']?/i,
    severity: "caution",
    description: "Possible hardcoded credential or API key",
    label: "hardcoded-creds",
  },
  {
    regex: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/,
    severity: "dangerous",
    description: "Private key material detected",
    label: "hardcoded-creds",
  },
  // Invisible characters (zero-width / homoglyph obfuscation)
  {
    regex: INVISIBLE_CHARS_RE,
    severity: "caution",
    description: "Invisible/zero-width characters detected (possible obfuscation)",
    label: "invisible-chars",
  },
]

function worstOf(severities: Severity[]): Severity {
  if (severities.includes("dangerous")) return "dangerous"
  if (severities.includes("caution")) return "caution"
  return "safe"
}

async function collectFiles(dir: string): Promise<string[]> {
  const result: string[] = []
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (entry.name.startsWith(".versions")) continue // skip version snapshots
    const full = path.join(dir, entry.name)
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      result.push(...(await collectFiles(full)))
    } else if (entry.isFile()) {
      result.push(full)
    }
  }
  return result
}

export namespace Guard {
  /**
   * Scan all text files in skillDir for security issues.
   * Binary files, files exceeding MAX_FILE_SIZE_BYTES, or scans exceeding
   * MAX_SCAN_FILES / MAX_TOTAL_SIZE_BYTES are rejected with a dangerous issue.
   */
  export async function scan(skillDir: string, _source?: string): Promise<ScanResult> {
    const files = await collectFiles(skillDir)
    const issues: Issue[] = []

    if (files.length > MAX_SCAN_FILES) {
      issues.push({
        file: skillDir,
        line: 0,
        pattern: "file-count",
        severity: "dangerous",
        description: `Too many files in skill directory (${files.length} > ${MAX_SCAN_FILES})`,
      })
      return { issues, worstSeverity: "dangerous" }
    }

    let totalBytes = 0

    for (const filePath of files) {
      const stat = await fs.stat(filePath).catch(() => null)
      if (!stat) continue

      if (stat.size > MAX_FILE_SIZE_BYTES) {
        issues.push({
          file: filePath,
          line: 0,
          pattern: "file-size",
          severity: "dangerous",
          description: `File exceeds size limit (${stat.size} bytes > ${MAX_FILE_SIZE_BYTES})`,
        })
        continue
      }

      totalBytes += stat.size
      if (totalBytes > MAX_TOTAL_SIZE_BYTES) {
        issues.push({
          file: filePath,
          line: 0,
          pattern: "total-size",
          severity: "dangerous",
          description: `Total scan size exceeded ${MAX_TOTAL_SIZE_BYTES} bytes`,
        })
        break
      }

      let text: string
      try {
        text = await fs.readFile(filePath, "utf-8")
      } catch {
        // Binary file — reject
        issues.push({
          file: filePath,
          line: 0,
          pattern: "binary-file",
          severity: "dangerous",
          description: "Binary file detected in skill directory",
        })
        continue
      }

      const lines = text.split("\n")
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        for (const p of PATTERNS) {
          if (p.regex.test(line)) {
            issues.push({
              file: filePath,
              line: i + 1,
              pattern: p.label,
              severity: p.severity,
              description: p.description,
            })
          }
        }
      }
    }

    return {
      issues,
      worstSeverity: worstOf(issues.map((i) => i.severity)),
    }
  }
}
