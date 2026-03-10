# LLM Prompt for Generating File Summaries

## Purpose

When a new file is added to a project, use this prompt to have the LLM generate a one-sentence summary for the "Summary" column in the README navigation table.

## File Type Detection

Choose the appropriate system prompt based on file extension:

| File Type | Extensions |
|-----------|-----------|
| Documentation | `.md`, `.txt`, `.rst`, `.adoc`, `.doc`, `.docx` |
| Code | `.js`, `.ts`, `.py`, `.go`, `.rs`, `.java`, `.c`, `.cpp`, `.rb`, `.swift`, `.kt`, `.sh`, etc. |
| Configuration | `.json`, `.yaml`, `.yml`, `.toml`, `.ini`, `.env`, `.xml`, `.conf` |
| General | Everything else (use the fallback prompt) |

## System Prompts by File Type

### Documentation

```
Summarize the core content of this document in one sentence (max 60 characters). Output only the summary.
```

### Code

```
Summarize the main functionality of this code file in one sentence (max 60 characters). Output only the summary.
```

### Configuration

```
Summarize the purpose and key settings of this configuration file in one sentence (max 60 characters). Output only the summary.
```

### General (fallback)

```
Summarize the core content of this file in one sentence (max 60 characters). Output only the summary.
```

## User Message

Send the file content (first 4000 characters) as the user message.

## Output Requirements

- Length: max 60 characters (strictly enforced—count before outputting)
- Output only the summary itself, without any prefix, label, or explanation
- Language should match the primary language of the file content

## Examples

### Input (Documentation)

An architecture design document for a user authentication module.

### Output

```
JWT auth design with refresh tokens and permissions
```

### Input (Code)

A Python file implementing a database migration tool.

### Output

```
DB migration with version control and auto-rollback
```

## Notes

- Summaries should focus on "what this file does", not implementation details
- For design documents, prioritize mentioning decisions and approaches
- For code files, prioritize mentioning functionality and algorithm names
- Abbreviate where necessary to stay within 60 characters (e.g., "DB" for "database", "auth" for "authentication")
