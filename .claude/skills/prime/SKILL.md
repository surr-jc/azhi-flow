---
name: prime
model: haiku
description: Primes the agent with deep codebase understanding by analyzing structure, documentation, and key files. Use when starting work on a codebase, at the beginning of a session, or when you need a fast orientation before planning or implementing. Optionally pulls external task context from Jira issues and Confluence pages first.
argument-hint: "[ticket] [confluence-page-ids]"
---

# Prime: Load Project Context

## Objective

Build comprehensive understanding of the codebase by analyzing structure, documentation, and key files. If external task references are provided, load them first so the codebase analysis is anchored to the actual work.

## Process

### Step 0: Load External Context

Accepts optional arguments: `[ticket] [confluence-page-ids]`, where `ticket` is a Jira key, a GitHub
issue (`owner/repo#N`, `#N` or URL), or `.claude/work/<KEY>/ticket.json` when intake already ran.

- If `.claude/work/<KEY>/ticket.json` exists, read it and `context.md`. Do not fetch again.
- Otherwise run the `intake` skill with the same arguments; it handles Jira, GitHub and Confluence.
- No arguments: skip this step.

Summarize the ticket in three lines before continuing.

### 1. Analyze Project Structure

List all tracked files:
!`git ls-files`

Show directory structure:
Use `git ls-files | head -200` (portable; `tree` is not on every OS). Skip vendored and build output (`node_modules`, `dist`, `build`, `target`, `.venv`).

### 2. Read Core Documentation

- Read CLAUDE.md or similar global rules file
- Read README files at project root and major directories
- Read any architecture documentation

### 3. Identify Key Files

Based on the structure, identify and read:
- Main entry points (main.py, index.ts, app.py, etc.)
- Core configuration files (pyproject.toml, package.json, tsconfig.json)
- Key model/schema definitions
- Important service or controller files

### 4. Understand Current State

Check recent activity:
!`git log -10 --oneline`

Check current branch and status:
!`git status`

## Output Report

Provide a concise summary covering:

### External Task Context (if loaded)
- Jira issue(s): key, title, one-line goal, acceptance criteria
- Confluence page(s): title and what they specify

### Project Overview
- Purpose and type of application
- Primary technologies and frameworks
- Current version/state

### Architecture
- Overall structure and organization
- Key architectural patterns identified
- Important directories and their purposes

### Tech Stack
- Languages and versions
- Frameworks and major libraries
- Build tools and package managers
- Testing frameworks

### Core Principles
- Code style and conventions observed
- Documentation standards
- Testing approach

### Current State
- Active branch
- Recent changes or development focus
- Any immediate observations or concerns

**Make this summary easy to scan - use bullet points and clear headers.**
