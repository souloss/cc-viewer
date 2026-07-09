declare const require: (moduleName: string) => any
declare const process: any

const { execFileSync } = require('node:child_process')
const os = require('node:os')
const { delimiter, sep } = require('node:path')

export type SystemPromptVariableValue = string | number

export type TemplateVariables = Record<string, unknown>

export type SystemPromptVariables = {
  environment: {
    cwd: string
    originalCwd: string
    home: string
    user: string
    workspaceRoots: string
    path: string
    lang: string
  }
  git: {
    isRepository: string
    root: string
    branch: string
    mainBranch: string
    userName: string
    status: string
    recentCommits: string
  }
  os: {
    platform: string
    type: string
    arch: string
    shell: string
    version: string
    release: string
    hostname: string
    availableParallelism: number | ''
    totalMemory: number | ''
    freeMemory: number | ''
    uptime: number | ''
  }
  runtime: {
    nodeVersion: string
    execPath: string
    pid: number | ''
    ppid: number | ''
  }
  time: {
    current: string
    iso: string
    date: string
    timezone: string
  }
  permissions: {
    mode: string
    approvalsReviewer: string
  }
  sandbox: {
    mode: string
    networkAccess: string
    writableRoots: string
  }
  terminal: {
    term: string
    colorTerm: string
    columns: number | ''
    rows: number | ''
  }
  filesystem: {
    tmpdir: string
    pathSeparator: string
    pathDelimiter: string
  }
  model: {
    name: string
    knowledgeCutoff: string
  }
}

export type PartialSystemPromptVariables = {
  [Key in keyof SystemPromptVariables]?: Partial<SystemPromptVariables[Key]>
}

export type MissingVariableMode = 'empty' | 'keep' | 'throw'

export type CreateSystemPromptOptions = {
  variables: SystemPromptVariables
  missingVariableMode?: MissingVariableMode
}

const TEMPLATE_VARIABLE_PATTERN = /\$\{([^}]+)\}/g

function stringifyTemplateValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : ''
  }
  return ''
}

function stringOrEmpty(readValue: () => unknown): string {
  try {
    const value = readValue()
    if (value === null || value === undefined) return ''
    return String(value)
  } catch {
    return ''
  }
}

function numberOrEmpty(readValue: () => unknown): number | '' {
  try {
    const value = Number(readValue())
    return Number.isFinite(value) ? value : ''
  } catch {
    return ''
  }
}

function envString(name: string): string {
  return stringOrEmpty(() => process.env[name] ?? '')
}

function commandOutput(command: string, args: string[], cwd: string): string {
  return stringOrEmpty(() =>
    execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim(),
  )
}

function firstNonEmpty(...values: string[]): string {
  return values.find(value => value.length > 0) ?? ''
}

function currentDate(timeZone: string, date: Date): string {
  if (timeZone.length > 0) {
    const formatted = stringOrEmpty(() =>
      new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(date),
    )
    if (formatted.length > 0) return formatted
  }
  return stringOrEmpty(() => date.toISOString().slice(0, 10))
}

function mergeSystemPromptVariables(
  base: SystemPromptVariables,
  overrides: PartialSystemPromptVariables,
): SystemPromptVariables {
  return {
    environment: { ...base.environment, ...overrides.environment },
    git: { ...base.git, ...overrides.git },
    os: { ...base.os, ...overrides.os },
    runtime: { ...base.runtime, ...overrides.runtime },
    time: { ...base.time, ...overrides.time },
    permissions: { ...base.permissions, ...overrides.permissions },
    sandbox: { ...base.sandbox, ...overrides.sandbox },
    terminal: { ...base.terminal, ...overrides.terminal },
    filesystem: { ...base.filesystem, ...overrides.filesystem },
    model: { ...base.model, ...overrides.model },
  }
}

export function createSystemPromptVariables(
  overrides: PartialSystemPromptVariables = {},
): SystemPromptVariables {
  const cwd = stringOrEmpty(() => process.cwd())
  const now = new Date()
  const timeZone = stringOrEmpty(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  )
  const isGitRepository =
    commandOutput('git', ['rev-parse', '--is-inside-work-tree'], cwd) === 'true'
  const gitRoot = isGitRepository
    ? commandOutput('git', ['rev-parse', '--show-toplevel'], cwd)
    : ''
  const gitBranch = isGitRepository
    ? firstNonEmpty(
        commandOutput('git', ['branch', '--show-current'], cwd),
        commandOutput('git', ['rev-parse', '--short', 'HEAD'], cwd),
      )
    : ''
  const gitMainBranch = isGitRepository
    ? firstNonEmpty(
        commandOutput('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd).replace(/^origin\//, ''),
        commandOutput('git', ['config', '--get', 'init.defaultBranch'], cwd),
      )
    : ''

  const variables: SystemPromptVariables = {
    environment: {
      cwd,
      originalCwd: envString('PWD'),
      home: envString('HOME'),
      user: firstNonEmpty(envString('USER'), envString('USERNAME')),
      workspaceRoots: firstNonEmpty(
        envString('CODEX_WORKSPACE_ROOTS'),
        envString('CLAUDE_WORKSPACE_ROOTS'),
      ),
      path: envString('PATH'),
      lang: firstNonEmpty(envString('LANG'), envString('LC_ALL')),
    },
    git: {
      isRepository: isGitRepository ? 'true' : 'false',
      root: gitRoot,
      branch: gitBranch,
      mainBranch: gitMainBranch,
      userName: isGitRepository
        ? commandOutput('git', ['config', 'user.name'], cwd)
        : '',
      status: isGitRepository
        ? commandOutput('git', ['status', '--short'], cwd)
        : '',
      recentCommits: isGitRepository
        ? commandOutput('git', ['log', '--oneline', '-5'], cwd)
        : '',
    },
    os: {
      platform: stringOrEmpty(() => process.platform),
      type: stringOrEmpty(() => os.type()),
      arch: stringOrEmpty(() => os.arch()),
      shell: envString('SHELL'),
      version: stringOrEmpty(() => os.version()),
      release: stringOrEmpty(() => os.release()),
      hostname: stringOrEmpty(() => os.hostname()),
      availableParallelism: numberOrEmpty(() => os.availableParallelism()),
      totalMemory: numberOrEmpty(() => os.totalmem()),
      freeMemory: numberOrEmpty(() => os.freemem()),
      uptime: numberOrEmpty(() => os.uptime()),
    },
    runtime: {
      nodeVersion: stringOrEmpty(() => process.version),
      execPath: stringOrEmpty(() => process.execPath),
      pid: numberOrEmpty(() => process.pid),
      ppid: numberOrEmpty(() => process.ppid),
    },
    time: {
      current: stringOrEmpty(() => now.toString()),
      iso: stringOrEmpty(() => now.toISOString()),
      date: currentDate(timeZone, now),
      timezone: timeZone,
    },
    permissions: {
      mode: firstNonEmpty(
        envString('CLAUDE_PERMISSION_MODE'),
        envString('CODEX_PERMISSION_MODE'),
      ),
      approvalsReviewer: envString('CODEX_APPROVALS_REVIEWER'),
    },
    sandbox: {
      mode: firstNonEmpty(envString('SANDBOX_MODE'), envString('CODEX_SANDBOX_MODE')),
      networkAccess: firstNonEmpty(
        envString('NETWORK_ACCESS'),
        envString('CODEX_NETWORK_ACCESS'),
      ),
      writableRoots: firstNonEmpty(
        envString('WRITABLE_ROOTS'),
        envString('CODEX_WRITABLE_ROOTS'),
      ),
    },
    terminal: {
      term: envString('TERM'),
      colorTerm: envString('COLORTERM'),
      columns: numberOrEmpty(() => process.stdout.columns),
      rows: numberOrEmpty(() => process.stdout.rows),
    },
    filesystem: {
      tmpdir: stringOrEmpty(() => os.tmpdir()),
      pathSeparator: sep,
      pathDelimiter: delimiter,
    },
    model: {
      name: firstNonEmpty(envString('CLAUDE_MODEL'), envString('ANTHROPIC_MODEL')),
      knowledgeCutoff: envString('CLAUDE_KNOWLEDGE_CUTOFF'),
    },
  }

  return mergeSystemPromptVariables(variables, overrides)
}

function readDottedPath(path: string, variables: TemplateVariables): unknown {
  const normalizedPath = path.trim()
  if (Object.prototype.hasOwnProperty.call(variables, normalizedPath)) {
    return variables[normalizedPath]
  }

  return normalizedPath.split('.').reduce<unknown>((current, key) => {
    if (
      current === null ||
      current === undefined ||
      typeof current !== 'object' ||
      !Object.prototype.hasOwnProperty.call(current, key)
    ) {
      return undefined
    }
    return (current as Record<string, unknown>)[key]
  }, variables)
}

function replaceTemplateVariable(
  rawMatch: string,
  rawName: string,
  variables: TemplateVariables,
  missingVariableMode: MissingVariableMode,
): string {
  const value = readDottedPath(rawName, variables)
  if (value !== undefined) {
    return stringifyTemplateValue(value)
  }

  if (missingVariableMode === 'keep') return rawMatch
  if (missingVariableMode === 'throw') {
    throw new Error(`Missing system prompt template variable: ${rawName.trim()}`)
  }
  return ''
}

export function listTemplateVariables(markdownTemplate: string): string[] {
  const names = new Set<string>()
  for (const match of markdownTemplate.matchAll(TEMPLATE_VARIABLE_PATTERN)) {
    names.add(match[1].trim())
  }
  return Array.from(names).sort()
}

export function createSystemPrompt(
  markdownTemplate: string,
  options: CreateSystemPromptOptions,
): string {
  const variables = options.variables as TemplateVariables
  const missingVariableMode = options.missingVariableMode ?? 'throw'

  return markdownTemplate.replace(TEMPLATE_VARIABLE_PATTERN, (match, name) =>
    replaceTemplateVariable(match, name, variables, missingVariableMode),
  )
}
