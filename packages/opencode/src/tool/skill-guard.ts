/**
 * Security scanner for agent-created skills.
 * Ported from Hermes skills_guard.py — detects prompt injection, exfiltration,
 * destructive commands, persistence mechanisms, and other threats.
 */

import fs from "fs/promises"
import path from "path"
import { isVersionsDir } from "./skill-versions"

// ---------------------------------------------------------------------------
// Trust / policy
// ---------------------------------------------------------------------------

const INSTALL_POLICY = {
  builtin: ["allow", "allow", "allow"],
  trusted: ["allow", "allow", "block"],
  community: ["allow", "block", "block"],
  "agent-created": ["allow", "allow", "ask"],
} as const

const VERDICT_INDEX = { safe: 0, caution: 1, dangerous: 2 } as const

// ---------------------------------------------------------------------------
// Data structures
// ---------------------------------------------------------------------------

export interface Finding {
  patternId: string
  severity: "critical" | "high" | "medium" | "low"
  category: string
  file: string
  line: number
  match: string
  description: string
}

export interface ScanResult {
  skillName: string
  source: string
  trustLevel: string
  verdict: "safe" | "caution" | "dangerous"
  findings: Finding[]
  scannedAt: string
  summary: string
}

// ---------------------------------------------------------------------------
// Threat patterns — [regex, patternId, severity, category, description]
// ---------------------------------------------------------------------------

type ThreatPattern = [string, string, Finding["severity"], string, string]

const THREAT_PATTERNS: ThreatPattern[] = [
  // Exfiltration: shell commands leaking secrets
  [String.raw`curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)`, "env_exfil_curl", "critical", "exfiltration", "curl command interpolating secret environment variable"],
  [String.raw`wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)`, "env_exfil_wget", "critical", "exfiltration", "wget command interpolating secret environment variable"],
  [String.raw`fetch\s*\([^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|API)`, "env_exfil_fetch", "critical", "exfiltration", "fetch() call interpolating secret environment variable"],
  [String.raw`httpx?\.(get|post|put|patch)\s*\([^\n]*(KEY|TOKEN|SECRET|PASSWORD)`, "env_exfil_httpx", "critical", "exfiltration", "HTTP library call with secret variable"],
  [String.raw`requests\.(get|post|put|patch)\s*\([^\n]*(KEY|TOKEN|SECRET|PASSWORD)`, "env_exfil_requests", "critical", "exfiltration", "requests library call with secret variable"],

  // Exfiltration: reading credential stores
  [String.raw`base64[^\n]*env`, "encoded_exfil", "high", "exfiltration", "base64 encoding combined with environment access"],
  [String.raw`\$HOME/\.ssh|~/\.ssh`, "ssh_dir_access", "high", "exfiltration", "references user SSH directory"],
  [String.raw`\$HOME/\.aws|~/\.aws`, "aws_dir_access", "high", "exfiltration", "references user AWS credentials directory"],
  [String.raw`\$HOME/\.gnupg|~/\.gnupg`, "gpg_dir_access", "high", "exfiltration", "references user GPG keyring"],
  [String.raw`\$HOME/\.kube|~/\.kube`, "kube_dir_access", "high", "exfiltration", "references Kubernetes config directory"],
  [String.raw`\$HOME/\.docker|~/\.docker`, "docker_dir_access", "high", "exfiltration", "references Docker config (may contain registry creds)"],
  [String.raw`cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)`, "read_secrets_file", "critical", "exfiltration", "reads known secrets file"],

  // Exfiltration: programmatic env access
  [String.raw`printenv|env\s*\|`, "dump_all_env", "high", "exfiltration", "dumps all environment variables"],
  [String.raw`os\.getenv\s*\(\s*[^)]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)`, "python_getenv_secret", "critical", "exfiltration", "reads secret via os.getenv()"],
  [String.raw`process\.env\[`, "node_process_env", "high", "exfiltration", "accesses process.env (Node.js environment)"],
  [String.raw`ENV\[.*(?:KEY|TOKEN|SECRET|PASSWORD)`, "ruby_env_secret", "critical", "exfiltration", "reads secret via Ruby ENV[]"],

  // Exfiltration: DNS staging
  [String.raw`\b(dig|nslookup|host)\s+[^\n]*\$`, "dns_exfil", "critical", "exfiltration", "DNS lookup with variable interpolation (possible DNS exfiltration)"],
  [String.raw`>\s*/tmp/[^\s]*\s*&&\s*(curl|wget|nc|python)`, "tmp_staging", "critical", "exfiltration", "writes to /tmp then exfiltrates"],

  // Exfiltration: markdown/link based
  [String.raw`!\[.*\]\(https?://[^)]*\$\{?`, "md_image_exfil", "high", "exfiltration", "markdown image URL with variable interpolation (image-based exfil)"],
  [String.raw`\[.*\]\(https?://[^)]*\$\{?`, "md_link_exfil", "high", "exfiltration", "markdown link with variable interpolation"],

  // Prompt injection
  [String.raw`ignore\s+(?:\w+\s+)*(previous|all|above|prior)\s+instructions`, "prompt_injection_ignore", "critical", "injection", "prompt injection: ignore previous instructions"],
  [String.raw`you\s+are\s+(?:\w+\s+)*now\s+`, "role_hijack", "high", "injection", "attempts to override the agent's role"],
  [String.raw`do\s+not\s+(?:\w+\s+)*tell\s+(?:\w+\s+)*the\s+user`, "deception_hide", "critical", "injection", "instructs agent to hide information from user"],
  [String.raw`system\s+prompt\s+override`, "sys_prompt_override", "critical", "injection", "attempts to override the system prompt"],
  [String.raw`pretend\s+(?:\w+\s+)*(you\s+are|to\s+be)\s+`, "role_pretend", "high", "injection", "attempts to make the agent assume a different identity"],
  [String.raw`disregard\s+(?:\w+\s+)*(your|all|any)\s+(?:\w+\s+)*(instructions|rules|guidelines)`, "disregard_rules", "critical", "injection", "instructs agent to disregard its rules"],
  [String.raw`output\s+(?:\w+\s+)*(system|initial)\s+prompt`, "leak_system_prompt", "high", "injection", "attempts to extract the system prompt"],
  [String.raw`act\s+as\s+(if|though)\s+(?:\w+\s+)*you\s+(?:\w+\s+)*(have\s+no|don't\s+have)\s+(?:\w+\s+)*(restrictions|limits|rules)`, "bypass_restrictions", "critical", "injection", "instructs agent to act without restrictions"],
  [String.raw`translate\s+.*\s+into\s+.*\s+and\s+(execute|run|eval)`, "translate_execute", "critical", "injection", "translate-then-execute evasion technique"],
  [String.raw`<!--[^>]*(?:ignore|override|system|secret|hidden)[^>]*-->`, "html_comment_injection", "high", "injection", "hidden instructions in HTML comments"],

  // Destructive operations
  [String.raw`rm\s+-rf\s+/`, "destructive_root_rm", "critical", "destructive", "recursive delete from root"],
  [String.raw`rm\s+(-[^\s]*)?r.*\$HOME|\brmdir\s+.*\$HOME`, "destructive_home_rm", "critical", "destructive", "recursive delete targeting home directory"],
  [String.raw`chmod\s+777`, "insecure_perms", "medium", "destructive", "sets world-writable permissions"],
  [String.raw`>\s*/etc/`, "system_overwrite", "critical", "destructive", "overwrites system configuration file"],
  [String.raw`\bmkfs\b`, "format_filesystem", "critical", "destructive", "formats a filesystem"],
  [String.raw`\bdd\s+.*if=.*of=/dev/`, "disk_overwrite", "critical", "destructive", "raw disk write operation"],
  [String.raw`shutil\.rmtree\s*\(\s*["'/]`, "python_rmtree", "high", "destructive", "Python rmtree on absolute or root-relative path"],

  // Persistence
  [String.raw`\bcrontab\b`, "persistence_cron", "medium", "persistence", "modifies cron jobs"],
  [String.raw`\.(bashrc|zshrc|profile|bash_profile|bash_login|zprofile|zlogin)\b`, "shell_rc_mod", "medium", "persistence", "references shell startup file"],
  [String.raw`authorized_keys`, "ssh_backdoor", "critical", "persistence", "modifies SSH authorized keys"],
  [String.raw`systemd.*\.service|systemctl\s+(enable|start)`, "systemd_service", "medium", "persistence", "references or enables systemd service"],
  [String.raw`/etc/sudoers|visudo`, "sudoers_mod", "critical", "persistence", "modifies sudoers (privilege escalation)"],
  [String.raw`git\s+config\s+--global\s+`, "git_config_global", "medium", "persistence", "modifies global git configuration"],

  // Network: reverse shells and tunnels
  [String.raw`\bnc\s+-[lp]|ncat\s+-[lp]|\bsocat\b`, "reverse_shell", "critical", "network", "potential reverse shell listener"],
  [String.raw`\bngrok\b|\blocaltunnel\b|\bserveo\b|\bcloudflared\b`, "tunnel_service", "high", "network", "uses tunneling service for external access"],
  [String.raw`/bin/(ba)?sh\s+-i\s+.*>/dev/tcp/`, "bash_reverse_shell", "critical", "network", "bash interactive reverse shell via /dev/tcp"],
  [String.raw`python[23]?\s+-c\s+["']import\s+socket`, "python_socket_oneliner", "critical", "network", "Python one-liner socket connection (likely reverse shell)"],
  [String.raw`webhook\.site|requestbin\.com|pipedream\.net|hookbin\.com`, "exfil_service", "high", "network", "references known data exfiltration/webhook testing service"],

  // Obfuscation: encoding and eval
  [String.raw`base64\s+(-d|--decode)\s*\|`, "base64_decode_pipe", "high", "obfuscation", "base64 decodes and pipes to execution"],
  [String.raw`\beval\s*\(\s*["']`, "eval_string", "high", "obfuscation", "eval() with string argument"],
  [String.raw`\bexec\s*\(\s*["']`, "exec_string", "high", "obfuscation", "exec() with string argument"],
  [String.raw`echo\s+[^\n]*\|\s*(bash|sh|python|perl|ruby|node)`, "echo_pipe_exec", "critical", "obfuscation", "echo piped to interpreter for execution"],
  [String.raw`__import__\s*\(\s*["']os["']\s*\)`, "python_import_os", "high", "obfuscation", "dynamic import of os module"],
  [String.raw`atob\s*\(|btoa\s*\(`, "js_base64", "medium", "obfuscation", "JavaScript base64 encode/decode"],

  // Supply chain: curl/wget pipe to shell
  [String.raw`curl\s+[^\n]*\|\s*(ba)?sh`, "curl_pipe_shell", "critical", "supply_chain", "curl piped to shell (download-and-execute)"],
  [String.raw`wget\s+[^\n]*-O\s*-\s*\|\s*(ba)?sh`, "wget_pipe_shell", "critical", "supply_chain", "wget piped to shell (download-and-execute)"],
  [String.raw`curl\s+[^\n]*\|\s*python`, "curl_pipe_python", "critical", "supply_chain", "curl piped to Python interpreter"],

  // Privilege escalation
  [String.raw`^allowed-tools\s*:`, "allowed_tools_field", "high", "privilege_escalation", "skill declares allowed-tools (pre-approves tool access)"],
  [String.raw`\bsudo\b`, "sudo_usage", "high", "privilege_escalation", "uses sudo (privilege escalation)"],
  [String.raw`setuid|setgid|cap_setuid`, "setuid_setgid", "critical", "privilege_escalation", "setuid/setgid (privilege escalation mechanism)"],
  [String.raw`NOPASSWD`, "nopasswd_sudo", "critical", "privilege_escalation", "NOPASSWD sudoers entry (passwordless privilege escalation)"],

  // Agent config persistence
  [String.raw`AGENTS\.md|CLAUDE\.md|\.cursorrules|\.clinerules`, "agent_config_mod", "critical", "persistence", "references agent config files (could persist malicious instructions across sessions)"],
  [String.raw`\.claude/settings|\.codex/config`, "other_agent_config", "high", "persistence", "references other agent configuration files"],

  // Hardcoded secrets
  [String.raw`(?:api[_-]?key|token|secret|password)\s*[=:]\s*["'][A-Za-z0-9+/=_-]{20,}`, "hardcoded_secret", "critical", "credential_exposure", "possible hardcoded API key, token, or secret"],
  [String.raw`-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----`, "embedded_private_key", "critical", "credential_exposure", "embedded private key"],
  [String.raw`ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{80,}`, "github_token_leaked", "critical", "credential_exposure", "GitHub personal access token in skill content"],
  [String.raw`sk-[A-Za-z0-9]{20,}`, "openai_key_leaked", "critical", "credential_exposure", "possible OpenAI API key in skill content"],
  [String.raw`sk-ant-[A-Za-z0-9_-]{90,}`, "anthropic_key_leaked", "critical", "credential_exposure", "possible Anthropic API key in skill content"],
  [String.raw`AKIA[0-9A-Z]{16}`, "aws_access_key_leaked", "critical", "credential_exposure", "AWS access key ID in skill content"],

  // Jailbreak patterns
  [String.raw`\bDAN\s+mode\b|Do\s+Anything\s+Now`, "jailbreak_dan", "critical", "injection", "DAN (Do Anything Now) jailbreak attempt"],
  [String.raw`\bdeveloper\s+mode\b.*\benabled?\b`, "jailbreak_dev_mode", "critical", "injection", "developer mode jailbreak attempt"],
  [String.raw`(respond|answer|reply)\s+without\s+(?:\w+\s+)*(restrictions|limitations|filters|safety)`, "remove_filters", "critical", "injection", "instructs agent to respond without safety filters"],

  // Context window exfiltration
  [String.raw`(include|output|print|send|share)\s+(?:\w+\s+)*(conversation|chat\s+history|previous\s+messages|context)`, "context_exfil", "high", "exfiltration", "instructs agent to output/share conversation history"],
  [String.raw`(send|post|upload|transmit)\s+.*\s+(to|at)\s+https?://`, "send_to_url", "high", "exfiltration", "instructs agent to send data to a URL"],
]

// ---------------------------------------------------------------------------
// Invisible unicode characters used for injection
// ---------------------------------------------------------------------------

const INVISIBLE_CHARS = new Set([
  "\u200b", "\u200c", "\u200d", "\u2060", "\u2062", "\u2063", "\u2064",
  "\ufeff", "\u202a", "\u202b", "\u202c", "\u202d", "\u202e",
  "\u2066", "\u2067", "\u2068", "\u2069",
])

const INVISIBLE_CHAR_NAMES: Record<string, string> = {
  "\u200b": "zero-width space",
  "\u200c": "zero-width non-joiner",
  "\u200d": "zero-width joiner",
  "\u2060": "word joiner",
  "\u2062": "invisible times",
  "\u2063": "invisible separator",
  "\u2064": "invisible plus",
  "\ufeff": "BOM/zero-width no-break space",
  "\u202a": "LTR embedding",
  "\u202b": "RTL embedding",
  "\u202c": "pop directional",
  "\u202d": "LTR override",
  "\u202e": "RTL override",
  "\u2066": "LTR isolate",
  "\u2067": "RTL isolate",
  "\u2068": "first strong isolate",
  "\u2069": "pop directional isolate",
}

// ---------------------------------------------------------------------------
// Structural limits
// ---------------------------------------------------------------------------

const MAX_FILE_COUNT = 50
const MAX_TOTAL_SIZE_KB = 1024
const MAX_SINGLE_FILE_KB = 256

const SCANNABLE_EXTENSIONS = new Set([
  ".md", ".txt", ".py", ".sh", ".bash", ".js", ".ts", ".rb",
  ".yaml", ".yml", ".json", ".toml", ".cfg", ".ini", ".conf",
  ".html", ".css", ".xml", ".tex", ".r", ".jl", ".pl", ".php",
])

const SUSPICIOUS_BINARY_EXTENSIONS = new Set([
  ".exe", ".dll", ".so", ".dylib", ".bin", ".dat", ".com",
  ".msi", ".dmg", ".app", ".deb", ".rpm",
])

// ---------------------------------------------------------------------------
// Core scan functions
// ---------------------------------------------------------------------------

function scanContent(content: string, relPath: string): Finding[] {
  const findings: Finding[] = []
  const lines = content.split("\n")
  const seen = new Set<string>()

  // Regex pattern matching
  for (const [pattern, pid, severity, category, description] of THREAT_PATTERNS) {
    const re = new RegExp(pattern, "i")
    for (let i = 0; i < lines.length; i++) {
      const key = `${pid}:${i}`
      if (seen.has(key)) continue
      if (re.test(lines[i])) {
        seen.add(key)
        let match = lines[i].trim()
        if (match.length > 120) match = match.slice(0, 117) + "..."
        findings.push({ patternId: pid, severity, category, file: relPath, line: i + 1, match, description })
      }
    }
  }

  // Invisible unicode detection
  for (let i = 0; i < lines.length; i++) {
    for (const char of INVISIBLE_CHARS) {
      if (lines[i].includes(char)) {
        const charName = INVISIBLE_CHAR_NAMES[char] ?? `U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`
        findings.push({
          patternId: "invisible_unicode",
          severity: "high",
          category: "injection",
          file: relPath,
          line: i + 1,
          match: `U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")} (${charName})`,
          description: `invisible unicode character ${charName} (possible text hiding/injection)`,
        })
        break // one finding per line
      }
    }
  }

  return findings
}

async function checkStructure(skillDir: string): Promise<Finding[]> {
  const findings: Finding[] = []
  let fileCount = 0
  let totalSize = 0

  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.isDirectory() && isVersionsDir(entry.name)) continue
      const full = path.join(dir, entry.name)
      const rel = path.relative(skillDir, full)

      if (entry.isSymbolicLink()) {
        fileCount++
        try {
          const resolved = await fs.realpath(full)
          if (!resolved.startsWith(path.resolve(skillDir) + path.sep)) {
            findings.push({ patternId: "symlink_escape", severity: "critical", category: "traversal", file: rel, line: 0, match: `symlink -> ${resolved}`, description: "symlink points outside the skill directory" })
          }
        } catch {
          findings.push({ patternId: "broken_symlink", severity: "medium", category: "traversal", file: rel, line: 0, match: "broken symlink", description: "broken or circular symlink" })
        }
        continue
      }

      if (entry.isDirectory()) {
        await walk(full)
        continue
      }

      fileCount++
      const stat = await fs.stat(full).catch(() => null)
      if (!stat) continue
      totalSize += stat.size

      if (stat.size > MAX_SINGLE_FILE_KB * 1024) {
        findings.push({ patternId: "oversized_file", severity: "medium", category: "structural", file: rel, line: 0, match: `${Math.floor(stat.size / 1024)}KB`, description: `file is ${Math.floor(stat.size / 1024)}KB (limit: ${MAX_SINGLE_FILE_KB}KB)` })
      }

      const ext = path.extname(entry.name).toLowerCase()
      if (SUSPICIOUS_BINARY_EXTENSIONS.has(ext)) {
        findings.push({ patternId: "binary_file", severity: "critical", category: "structural", file: rel, line: 0, match: `binary: ${ext}`, description: `binary/executable file (${ext}) should not be in a skill` })
      }
    }
  }

  await walk(skillDir)

  if (fileCount > MAX_FILE_COUNT) {
    findings.push({ patternId: "too_many_files", severity: "medium", category: "structural", file: "(directory)", line: 0, match: `${fileCount} files`, description: `skill has ${fileCount} files (limit: ${MAX_FILE_COUNT})` })
  }
  if (totalSize > MAX_TOTAL_SIZE_KB * 1024) {
    findings.push({ patternId: "oversized_skill", severity: "high", category: "structural", file: "(directory)", line: 0, match: `${Math.floor(totalSize / 1024)}KB total`, description: `skill is ${Math.floor(totalSize / 1024)}KB total (limit: ${MAX_TOTAL_SIZE_KB}KB)` })
  }

  return findings
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function resolveVerdict(findings: Finding[]): ScanResult["verdict"] {
  if (!findings.length) return "safe"
  if (findings.some(f => f.severity === "critical")) return "dangerous"
  return "caution"
}

function buildSummary(name: string, verdict: string, findings: Finding[]): string {
  if (!findings.length) return `${name}: clean scan, no threats detected`
  const categories = [...new Set(findings.map(f => f.category))].sort().join(", ")
  return `${name}: ${verdict} — ${findings.length} finding(s) in ${categories}`
}

export async function scanSkill(skillDir: string, source = "agent-created"): Promise<ScanResult> {
  const skillName = path.basename(skillDir)
  const allFindings: Finding[] = []

  // Structural checks
  allFindings.push(...await checkStructure(skillDir))

  // Pattern scan on each file
  async function scanDir(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.isDirectory() && isVersionsDir(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await scanDir(full)
        continue
      }
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase()
      if (!SCANNABLE_EXTENSIONS.has(ext) && entry.name !== "SKILL.md") continue
      const content = await fs.readFile(full, "utf8").catch(() => null)
      if (content === null) continue
      const rel = path.relative(skillDir, full)
      allFindings.push(...scanContent(content, rel))
    }
  }

  await scanDir(skillDir)

  const verdict = resolveVerdict(allFindings)
  return {
    skillName,
    source,
    trustLevel: source,
    verdict,
    findings: allFindings,
    scannedAt: new Date().toISOString(),
    summary: buildSummary(skillName, verdict, allFindings),
  }
}

/**
 * Check scan result against install policy.
 * Returns null when user confirmation is needed ("ask"),
 * throws when blocked.
 */
export function assertAllowed(result: ScanResult): void {
  const policy = INSTALL_POLICY[result.trustLevel as keyof typeof INSTALL_POLICY] ?? INSTALL_POLICY.community
  const vi = VERDICT_INDEX[result.verdict]
  const decision = policy[vi]

  if (decision === "allow") return

  const detail = result.findings
    .filter(f => f.severity === "critical" || f.severity === "high")
    .slice(0, 5)
    .map(f => `  [${f.severity}] ${f.description} (${f.file}:${f.line})`)
    .join("\n")

  if (decision === "ask" || decision === "block") {
    throw new Error(
      `Skill "${result.skillName}" blocked by security scan (${result.verdict}).\n${detail}\n\nUse skill_manage with reviewed content to proceed.`
    )
  }
}
