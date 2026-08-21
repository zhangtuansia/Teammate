// Model runtimes can execute tools and access the network. Build their process
// environment from a deliberately small OS/runtime allowlist instead of trying
// to enumerate every possible secret a parent shell might contain.
const SAFE_RUNTIME_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "USER",
  "USERNAME",
  "LOGNAME",
  "SHELL",
  "COMSPEC",
  "SYSTEMROOT",
  "WINDIR",
  "PATHEXT",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LANGUAGE",
  "TERM",
  "COLORTERM",
  "TZ",
  "NO_COLOR",
  "FORCE_COLOR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "__CF_USER_TEXT_ENCODING",
]);

const PACKAGED_RUNTIME_ENV_KEYS = new Set([
  "TEAMMATE_CLI_PATH",
  "TEAMMATE_PI_PATH",
  "TEAMMATE_PI_WORKER",
]);

export function runtimeProcessEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    const normalizedKey = key.toUpperCase();
    const safeOsValue =
      SAFE_RUNTIME_ENV_KEYS.has(normalizedKey) || normalizedKey.startsWith("LC_");
    const packagedRuntimeValue = PACKAGED_RUNTIME_ENV_KEYS.has(normalizedKey);
    if ((safeOsValue || packagedRuntimeValue) && value !== undefined) {
      environment[key] = value;
    }
  }
  return environment;
}
