# LLM Prompt for Generating Trigger Conditions

## Purpose

When a new file is added to a project, use this prompt to have the LLM generate a "trigger condition"—telling other AI models "under what circumstances should this file be read".

## System Prompt

```
Describe in one sentence: under what circumstances should this document be read? (max 40 characters, format: "When you need to..."). Output only this sentence, nothing else.
```

## User Message

Send the file content (first 4000 characters) as the user message.

## Output Requirements

- Format: "When you need to..."
- Length: max 40 characters (strictly enforced—count before outputting)
- Output only one sentence, without any additional explanation

## Examples

### Input

An architecture design document for a user authentication module.

### Output

```
When you need to review auth design
```

### Input

A Python database migration script.

### Output

```
When you need to run DB migrations
```

## Notes

- Trigger conditions should be specific to the file's actual content, not generic descriptions
- Avoid duplicating the parent directory's trigger condition (e.g., "When you need to view design docs"); be more specific (e.g., "When you need to review JWT auth flow")
- If the LLM call fails, use a generic trigger condition as a fallback (e.g., "When you need to view this file")
- Abbreviate where necessary to stay within 40 characters (e.g., "DB" for "database", "auth" for "authentication", "config" for "configuration")
