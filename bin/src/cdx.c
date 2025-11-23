#define _GNU_SOURCE
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <pwd.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>
#include <sys/select.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#ifdef __linux__
#include <pty.h>
#else
#include <util.h>
#endif

// Minimal C reimplementation of the historical bash-based `bin/cdx` wrapper.
// Network-heavy pieces (auth sync, usage push, release fetch) are delegated to
// small embedded Python snippets to preserve the exact protocol behavior while
// keeping the orchestrator compiled and fast.

// Colors
static int IS_TTY = 0;
static const char *BOLD = "";
static const char *DIM = "";
static const char *GREEN = "";
static const char *YELLOW = "";
static const char *BLUE = "";
static const char *RED = "";
static const char *RESET = "";
static const char *TAG_DIM = "";

static int CODEX_DEBUG = 0;
static int CODEX_SYNC_ALLOW_INSECURE = 0;
static int CODEX_SYNC_OPTIONAL = 0;

static const char *CODEX_SYNC_BASE_URL_DEFAULT = "https://codex-auth.uggs.io";
static char *CODEX_SYNC_BASE_URL = NULL;
static char *CODEX_SYNC_API_KEY = NULL;
static char *CODEX_SYNC_FQDN = NULL;
static char *CODEX_SYNC_CA_FILE = NULL;
static int SYNC_CONFIG_LOADED = 0;

static const char *WRAPPER_VERSION = "2025.11.23-3";

static int IS_ROOT = 0;
static int CAN_SUDO = 0;
static const char *SUDO_BIN = "sudo -n";
static char CURRENT_USER[64] = "unknown";

static char *AUTH_PULL_STATUS = NULL;
static char *AUTH_PULL_URL = NULL;
static char *AUTH_STATUS = NULL;
static char *AUTH_ACTION = NULL;
static char *AUTH_MESSAGE = NULL;
static char *SYNC_REMOTE_CLIENT_VERSION = NULL;
static char *SYNC_REMOTE_WRAPPER_VERSION = NULL;
static char *SYNC_REMOTE_WRAPPER_SHA256 = NULL;
static char *SYNC_REMOTE_WRAPPER_URL = NULL;
static int SYNC_WARNED_NO_PYTHON = 0;
static int SYNC_PUSH_COMPLETED = 0;
static char *ORIGINAL_LAST_REFRESH = NULL;
static char *AUTH_PUSH_RESULT = NULL;
static char *AUTH_PUSH_REASON = NULL;
static char *LOCAL_VERSION = NULL;
static int LOCAL_VERSION_UNKNOWN = 0;
static char *CODEX_REAL_BIN = NULL;
static char *SCRIPT_REAL = NULL;

// Utility helpers -----------------------------------------------------------
static char *safe_strdup(const char *s) {
    if (!s) return NULL;
    char *d = strdup(s);
    if (!d) {
        perror("strdup");
        exit(1);
    }
    return d;
}

static void set_colors(void) {
    IS_TTY = isatty(STDOUT_FILENO);
    if (IS_TTY) {
        BOLD = "\033[1m";
        DIM = "\033[2m";
        GREEN = "\033[32m";
        YELLOW = "\033[33m";
        BLUE = "\033[36m";
        RED = "\033[31m";
        RESET = "\033[0m";
        TAG_DIM = "\033[90m";
    } else {
        BOLD = "";
        DIM = "";
        GREEN = "";
        YELLOW = "";
        BLUE = "";
        RED = "";
        RESET = "";
        TAG_DIM = "";
    }
}

static void log_line(FILE *stream, const char *color, const char *label, const char *fmt, va_list ap) {
    if (IS_TTY && color && *color) fprintf(stream, "%s%s[%s]%s ", BOLD, color, label, RESET);
    else fprintf(stream, "[%s] ", label);
    vfprintf(stream, fmt, ap);
    fprintf(stream, "\n");
}

static void log_info(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    log_line(stdout, BLUE, "info", fmt, ap);
    va_end(ap);
}

static void log_warn(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    log_line(stderr, YELLOW, "warn", fmt, ap);
    va_end(ap);
}

static void log_error(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    log_line(stderr, RED, "fail", fmt, ap);
    va_end(ap);
}

static void log_debug(const char *fmt, ...) {
    if (!CODEX_DEBUG) return;
    va_list ap;
    va_start(ap, fmt);
    log_line(stderr, TAG_DIM, "debug", fmt, ap);
    va_end(ap);
}

static char *mask_key(const char *key) {
    if (!key || !*key) return safe_strdup("none");
    size_t len = strlen(key);
    if (len <= 8) return safe_strdup(key);
    char *out = malloc(len + 4);
    if (!out) exit(1);
    snprintf(out, len + 4, "%.*s…%s", 4, key, key + len - 4);
    return out;
}

static int command_exists(const char *cmd) {
    if (!cmd || !*cmd) return 0;
    char *path = getenv("PATH");
    if (!path) return 0;
    char *dup = safe_strdup(path);
    char *save = NULL;
    for (char *token = strtok_r(dup, ":", &save); token; token = strtok_r(NULL, ":", &save)) {
        if (*token == '\0') token = ".";
        char buf[PATH_MAX];
        snprintf(buf, sizeof(buf), "%s/%s", token, cmd);
        if (access(buf, X_OK) == 0) {
            free(dup);
            return 1;
        }
    }
    free(dup);
    return 0;
}

static int run_capture(const char *cmd, char **output) {
    FILE *fp = popen(cmd, "r");
    if (!fp) return -1;
    size_t cap = 4096, len = 0;
    char *buf = malloc(cap);
    if (!buf) exit(1);
    size_t n;
    while ((n = fread(buf + len, 1, cap - len, fp)) > 0) {
        len += n;
        if (len + 1024 > cap) {
            cap *= 2;
            buf = realloc(buf, cap);
            if (!buf) exit(1);
        }
    }
    buf[len] = '\0';
    int status = pclose(fp);
    if (output) *output = buf; else free(buf);
    return status;
}

static int run_status(const char *cmd) {
    int st = run_capture(cmd, NULL);
    if (st == -1) return -1;
    if (WIFEXITED(st)) return WEXITSTATUS(st);
    return -1;
}

static char *real_path(const char *path) {
    if (!path) return NULL;
    char resolved[PATH_MAX];
    if (realpath(path, resolved)) return safe_strdup(resolved);
    return safe_strdup(path);
}

static char *trim(char *s) {
    if (!s) return s;
    while (isspace((unsigned char)*s)) s++;
    char *end = s + strlen(s);
    while (end > s && isspace((unsigned char)*(end - 1))) end--;
    *end = '\0';
    return s;
}

static void detect_user(void) {
    struct passwd *pw = getpwuid(geteuid());
    if (pw && pw->pw_name) {
        snprintf(CURRENT_USER, sizeof(CURRENT_USER), "%s", pw->pw_name);
    } else {
        const char *u = getenv("USER");
        if (u) snprintf(CURRENT_USER, sizeof(CURRENT_USER), "%s", u);
    }
}

static void detect_privileges(void) {
    IS_ROOT = (geteuid() == 0);
    if (!IS_ROOT && command_exists("sudo")) {
        int rc = run_status("sudo -n true >/dev/null 2>&1");
        if (rc == 0) CAN_SUDO = 1;
    }
}

// Package manager detection and ensure_commands ----------------------------
static char *detect_linux_pm(void) {
    FILE *fp = fopen("/etc/os-release", "r");
    char *id = NULL; char *id_like = NULL;
    if (fp) {
        char line[256];
        while (fgets(line, sizeof(line), fp)) {
            if (strncmp(line, "ID=", 3) == 0) id = safe_strdup(trim(line + 3));
            if (strncmp(line, "ID_LIKE=", 8) == 0) id_like = safe_strdup(trim(line + 8));
        }
        fclose(fp);
    }
    char *candidates[8]; int count = 0;
    if (id) candidates[count++] = id;
    if (id_like) {
        char *dup = id_like; char *save = NULL;
        for (char *tok = strtok_r(dup, " ", &save); tok; tok = strtok_r(NULL, " ", &save)) {
            candidates[count++] = tok;
        }
    }
    for (int i = 0; i < count; i++) {
        if (strcmp(candidates[i], "debian") == 0 || strcmp(candidates[i], "ubuntu") == 0) {
            free(id); free(id_like);
            return safe_strdup("apt-get");
        }
        if (strcmp(candidates[i], "rhel") == 0 || strcmp(candidates[i], "centos") == 0 || strcmp(candidates[i], "fedora") == 0 || strcmp(candidates[i], "almalinux") == 0 || strcmp(candidates[i], "rocky") == 0 || strcmp(candidates[i], "ol") == 0) {
            free(id); free(id_like);
            return safe_strdup("dnf");
        }
    }
    free(id); free(id_like);
    if (command_exists("apt-get")) return safe_strdup("apt-get");
    if (command_exists("dnf")) return safe_strdup("dnf");
    return NULL;
}

static int ensure_commands(char **cmds, int count) {
    int missing = 0;
    for (int i = 0; i < count; i++) {
        if (!command_exists(cmds[i])) missing++;
    }
    if (!missing) return 0;
    char *pm = detect_linux_pm();
    if (!pm) {
        log_error("system  | missing commands and cannot detect package manager");
        return 1;
    }
    int use_sudo = (!IS_ROOT && CAN_SUDO);
    char cmdline[1024] = {0};
    if (strcmp(pm, "apt-get") == 0) {
        snprintf(cmdline, sizeof(cmdline), "%s apt-get update -qq && %s DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends", use_sudo ? SUDO_BIN : "", use_sudo ? SUDO_BIN : "");
    } else {
        snprintf(cmdline, sizeof(cmdline), "%s dnf install -y", use_sudo ? SUDO_BIN : "");
    }
    for (int i = 0; i < count; i++) {
        if (!command_exists(cmds[i])) {
            strncat(cmdline, " ", sizeof(cmdline) - strlen(cmdline) - 1);
            strncat(cmdline, cmds[i], sizeof(cmdline) - strlen(cmdline) - 1);
        }
    }
    char listbuf[256] = "";
    for (int i = 0; i < count; i++) {
        if (!command_exists(cmds[i])) {
            if (*listbuf) strncat(listbuf, ",", sizeof(listbuf) - strlen(listbuf) - 1);
            strncat(listbuf, cmds[i], sizeof(listbuf) - strlen(listbuf) - 1);
        }
    }
    log_info("system  | installing prerequisites (%s) with %s", listbuf, pm);
    int rc = run_status(cmdline);
    free(pm);
    if (rc != 0) return 1;
    for (int i = 0; i < count; i++) if (!command_exists(cmds[i])) return 1;
    return 0;
}

// Version helpers -----------------------------------------------------------
static char *normalize_version(const char *v) {
    if (!v) return NULL;
    while (*v == ' ') v++;
    if (strncmp(v, "codex-cli ", 10) == 0) v += 10;
    if (strncmp(v, "codex ", 6) == 0) v += 6;
    if (strncmp(v, "rust-", 5) == 0) v += 5;
    if (*v == 'v') v++;
    return safe_strdup(v);
}

static int version_compare(const char *a, const char *b) {
    if (!a && !b) return 0;
    if (!a) return -1;
    if (!b) return 1;
    char *da = safe_strdup(a);
    char *db = safe_strdup(b);
    char *pa = da, *pb = db;
    while (*pa || *pb) {
        while (*pa && !isalnum((unsigned char)*pa)) pa++;
        while (*pb && !isalnum((unsigned char)*pb)) pb++;
        if (!*pa && !*pb) break;
        char *enda = pa; while (*enda && (isalnum((unsigned char)*enda))) enda++;
        char *endb = pb; while (*endb && (isalnum((unsigned char)*endb))) endb++;
        int isnuma = isdigit((unsigned char)*pa);
        int isnumb = isdigit((unsigned char)*pb);
        if (isnuma && isnumb) {
            long va = strtol(pa, NULL, 10);
            long vb = strtol(pb, NULL, 10);
            if (va < vb) { free(da); free(db); return -1; }
            if (va > vb) { free(da); free(db); return 1; }
        } else {
            size_t la = enda - pa, lb = endb - pb;
            size_t m = la < lb ? la : lb;
            int cmp = strncasecmp(pa, pb, m);
            if (cmp != 0) { free(da); free(db); return cmp; }
            if (la != lb) { free(da); free(db); return la < lb ? -1 : 1; }
        }
        pa = enda; pb = endb;
    }
    free(da); free(db);
    return 0;
}

static char *detect_glibc_version(void) {
    char *out = NULL;
    if (run_capture("getconf GNU_LIBC_VERSION 2>/dev/null", &out) == 0 && out && strstr(out, ".")) {
        char *p = strchr(out, ' ');
        if (p) return trim(out + (p - out) + 1);
        return trim(out);
    }
    free(out);
    out = NULL;
    if (run_capture("ldd --version 2>&1 | head -n1", &out) == 0 && out && strstr(out, ".")) {
        char *q = out;
        while (*q && !isdigit((unsigned char)*q)) q++;
        return trim(q);
    }
    free(out);
    return NULL;
}

static int is_codex_installed_via_npm(void) {
    int st = run_status("npm list -g codex-cli --depth=0 >/dev/null 2>&1");
    return st == 0;
}

static int update_codex_via_npm(const char *target) {
    char cmd[256];
    if (!target || !*target) snprintf(cmd, sizeof(cmd), "npm install -g codex-cli >/dev/null");
    else snprintf(cmd, sizeof(cmd), "npm install -g \"codex-cli@%s\" >/dev/null", target);
    return run_status(cmd) == 0;
}

// Sync env loading ---------------------------------------------------------
static void parse_sync_env_file(const char *path) {
    FILE *fp = fopen(path, "r");
    if (!fp) return;
    char line[512];
    while (fgets(line, sizeof(line), fp)) {
        if (line[0] == '\0' || line[0] == '#') continue;
        char *eq = strchr(line, '=');
        if (!eq) continue;
        *eq = '\0';
        char *key = trim(line);
        char *val = trim(eq + 1);
        val[strcspn(val, "\r\n")] = '\0';
        if (strcmp(key, "CODEX_SYNC_BASE_URL") == 0) CODEX_SYNC_BASE_URL = safe_strdup(val);
        else if (strcmp(key, "CODEX_SYNC_API_KEY") == 0) CODEX_SYNC_API_KEY = safe_strdup(val);
        else if (strcmp(key, "CODEX_SYNC_FQDN") == 0) CODEX_SYNC_FQDN = safe_strdup(val);
        else if (strcmp(key, "CODEX_SYNC_CA_FILE") == 0) CODEX_SYNC_CA_FILE = safe_strdup(val);
    }
    fclose(fp);
    log_debug("loaded sync env: %s", path);
}

static void load_sync_config(void) {
    if (SYNC_CONFIG_LOADED) return;
    const char *cfg_env = getenv("CODEX_SYNC_CONFIG_PATH");
    const char *paths_default[] = {"/etc/codex-sync.env", "/usr/local/etc/codex-sync.env", NULL};
    char home_path[PATH_MAX];
    snprintf(home_path, sizeof(home_path), "%s/.codex/sync.env", getenv("HOME") ? getenv("HOME") : ".");

    if (cfg_env && *cfg_env) {
        parse_sync_env_file(cfg_env);
    } else {
        for (int i = 0; paths_default[i]; i++) parse_sync_env_file(paths_default[i]);
        parse_sync_env_file(home_path);
    }

    if (!CODEX_SYNC_BASE_URL) CODEX_SYNC_BASE_URL = safe_strdup(CODEX_SYNC_BASE_URL_DEFAULT);
    CODEX_SYNC_ALLOW_INSECURE = getenv("CODEX_SYNC_ALLOW_INSECURE") && strcmp(getenv("CODEX_SYNC_ALLOW_INSECURE"), "0") != 0;
    CODEX_SYNC_OPTIONAL = getenv("CODEX_SYNC_OPTIONAL") && strcmp(getenv("CODEX_SYNC_OPTIONAL"), "0") != 0;
    SYNC_CONFIG_LOADED = 1;
    char *masked = mask_key(CODEX_SYNC_API_KEY);
    log_debug("config | base=%s | api_key=%s | fqdn=%s | ca=%s | allow_insecure=%d", CODEX_SYNC_BASE_URL, masked, CODEX_SYNC_FQDN ? CODEX_SYNC_FQDN : "none", CODEX_SYNC_CA_FILE ? CODEX_SYNC_CA_FILE : "none", CODEX_SYNC_ALLOW_INSECURE);
    free(masked);
    if (CODEX_SYNC_ALLOW_INSECURE) log_warn("tls     | verification fallback to insecure context is ENABLED (CODEX_SYNC_ALLOW_INSECURE=1)");
}

// Embedded Python helpers --------------------------------------------------
static const char *PY_VALIDATE_AUTH =
"import json, sys, pathlib\n"
"path = pathlib.Path(sys.argv[1])\n"
"try:\n"
"    data = json.loads(path.read_text(encoding='utf-8'))\n"
"except Exception:\n"
"    sys.exit(1)\n"
"if not isinstance(data, dict):\n"
"    sys.exit(1)\n"
"last_refresh = data.get('last_refresh')\n"
"auths = data.get('auths')\n"
"tokens = data.get('tokens') if isinstance(data.get('tokens'), dict) else {}\n"
"access = tokens.get('access_token') if isinstance(tokens, dict) else None\n"
"api_key = data.get('OPENAI_API_KEY')\n"
"if not isinstance(last_refresh, str) or not last_refresh.strip():\n"
"    sys.exit(1)\n"
"auths_valid = isinstance(auths, dict) and len(auths) > 0\n"
"token_fallback = isinstance(access, str) and access.strip()\n"
"api_key_fallback = isinstance(api_key, str) and api_key.strip()\n"
"if not auths_valid and not token_fallback and not api_key_fallback:\n"
"    sys.exit(1)\n"
"if auths_valid:\n"
"    for target, entry in auths.items():\n"
"        if not isinstance(target, str) or not target.strip():\n"
"            sys.exit(1)\n"
"        if not isinstance(entry, dict):\n"
"            sys.exit(1)\n"
"        token = entry.get('token')\n"
"        if not isinstance(token, str) or not token.strip():\n"
"            sys.exit(1)\n"
"sys.exit(0)\n";

static const char *PY_LAST_REFRESH =
"import json, sys, pathlib\n"
"path = pathlib.Path(sys.argv[1])\n"
"try:\n"
"    data = json.loads(path.read_text(encoding='utf-8'))\n"
"except Exception:\n"
"    sys.exit(0)\n"
"if isinstance(data, dict):\n"
"    lr = data.get('last_refresh')\n"
"    if isinstance(lr, str):\n"
"        print(lr, end='')\n";

static const char *PY_AUTH_SYNC =
"import hashlib, json, os, pathlib, ssl, sys, urllib.error, urllib.request\n"
"base = (sys.argv[1] or '').rstrip('/')\n"
"api_key = sys.argv[2]\n"
"path = pathlib.Path(sys.argv[3]).expanduser()\n"
"cafile = sys.argv[4] if len(sys.argv) > 4 else ''\n"
"client_version = sys.argv[5] if len(sys.argv) > 5 else 'unknown'\n"
"wrapper_version = sys.argv[6] if len(sys.argv) > 6 else 'unknown'\n"
"if not base:\n"
"    print('Sync API base URL missing', file=sys.stderr)\n"
"    sys.exit(1)\n"
"def default_auth():\n"
"    return {'last_refresh': '2000-01-01T00:00:00Z', 'auths': {}}\n"
"def load_auth():\n"
"    try:\n"
"        data = json.loads(path.read_text(encoding='utf-8'))\n"
"    except Exception:\n"
"        return default_auth()\n"
"    if not isinstance(data, dict) or 'last_refresh' not in data:\n"
"        return default_auth()\n"
"    return data\n"
"def ensure_auths_fallback(auth_payload):\n"
"    has_auths = isinstance(auth_payload.get('auths'), dict) and len(auth_payload.get('auths', {})) > 0\n"
"    if has_auths:\n"
"        return auth_payload\n"
"    token_candidates = []\n"
"    tokens = auth_payload.get('tokens') if isinstance(auth_payload.get('tokens'), dict) else None\n"
"    if isinstance(tokens, dict):\n"
"        token_candidates.append(tokens.get('access_token'))\n"
"    token_candidates.append(auth_payload.get('OPENAI_API_KEY'))\n"
"    chosen = None\n"
"    for candidate in token_candidates:\n"
"        if isinstance(candidate, str) and candidate.strip():\n"
"            chosen = candidate.strip()\n"
"            break\n"
"    if chosen is None:\n"
"        return auth_payload\n"
"    auth_copy = dict(auth_payload)\n"
"    auth_copy['auths'] = {'api.openai.com': {'token': chosen, 'token_type': 'bearer'}}\n"
"    return auth_copy\n"
"def canonical_json(obj):\n"
"    return json.dumps(obj, ensure_ascii=False, separators=(',', ':'))\n"
"def build_context():\n"
"    allow_insecure = os.environ.get('CODEX_SYNC_ALLOW_INSECURE') in ('1', 'true', 'TRUE', 'yes', 'on')\n"
"    contexts = []\n"
"    ctx_primary = ssl.create_default_context()\n"
"    if cafile:\n"
"        try:\n"
"            ctx_primary.load_verify_locations(cafile)\n"
"        except Exception:\n"
"            ctx_primary = None\n"
"    if ctx_primary is not None:\n"
"        try:\n"
"            ctx_primary.verify_flags &= ~ssl.VERIFY_X509_STRICT\n"
"        except Exception:\n"
"            pass\n"
"        contexts.append(ctx_primary)\n"
"    try:\n"
"        ctx_default = ssl.create_default_context()\n"
"        ctx_default.verify_flags &= ~ssl.VERIFY_X509_STRICT\n"
"        contexts.append(ctx_default)\n"
"    except Exception:\n"
"        pass\n"
"    if allow_insecure:\n"
"        try:\n"
"            contexts.append(ssl._create_unverified_context())\n"
"        except Exception:\n"
"            pass\n"
"    return contexts or [None]\n"
"def parse_error_body(body):\n"
"    msg = body\n"
"    details = {}\n"
"    try:\n"
"        parsed = json.loads(body)\n"
"        if isinstance(parsed, dict):\n"
"            msg = parsed.get('message', body)\n"
"            details = parsed.get('details', {}) or {}\n"
"    except Exception:\n"
"        pass\n"
"    return msg, details\n"
"def fail_with_http(exc, action):\n"
"    body = exc.read().decode('utf-8', 'ignore')\n"
"    msg, details = parse_error_body(body)\n"
"    expected_ip = details.get('expected_ip') if isinstance(details, dict) else None\n"
"    received_ip = details.get('received_ip') if isinstance(details, dict) else None\n"
"    if exc.code == 401:\n"
"        if 'Invalid API key' in msg:\n"
"            sys.exit(10)\n"
"        if 'API key missing' in msg:\n"
"            sys.exit(21)\n"
"        sys.exit(22)\n"
"    if exc.code == 403:\n"
"        if 'Host is disabled' in msg:\n"
"            sys.exit(11)\n"
"        if 'not allowed from this IP' in msg or expected_ip or received_ip:\n"
"            sys.exit(12)\n"
"        sys.exit(23)\n"
"    if exc.code == 503 and 'disabled' in msg.lower():\n"
"        print('api disabled', file=sys.stderr)\n"
"        sys.exit(40)\n"
"    print(f\"{action} failed ({exc.code}): {msg}\", file=sys.stderr)\n"
"    sys.exit(2)\n"
"def post_json(url, payload, action):\n"
"    body = canonical_json(payload).encode('utf-8')\n"
"    headers = {'Content-Type': 'application/json', 'X-API-Key': api_key}\n"
"    req = urllib.request.Request(url, data=body, headers=headers, method='POST')\n"
"    contexts = build_context()\n"
"    last_err = None\n"
"    for ctx in contexts:\n"
"        try:\n"
"            with urllib.request.urlopen(req, timeout=20, context=ctx) as resp:\n"
"                return json.load(resp)\n"
"        except urllib.error.HTTPError as exc:\n"
"            fail_with_http(exc, action)\n"
"        except Exception as exc:\n"
"            last_err = exc\n"
"            continue\n"
"    print(f\"{action} failed: {last_err}\", file=sys.stderr)\n"
"    sys.exit(3)\n"
"current = load_auth()\n"
"current_for_sync = ensure_auths_fallback(current)\n"
"auth_json = canonical_json(current_for_sync)\n"
"auth_sha = hashlib.sha256(auth_json.encode('utf-8')).hexdigest()\n"
"retrieve_payload = {'command': 'retrieve','last_refresh': current.get('last_refresh') or '2000-01-01T00:00:00Z','digest': auth_sha,'client_version': client_version or 'unknown'}\n"
"if wrapper_version and wrapper_version != 'unknown':\n"
"    retrieve_payload['wrapper_version'] = wrapper_version\n"
"retrieve_data = post_json(f\"{base}/auth\", retrieve_payload, 'auth retrieve')\n"
"payload_data = retrieve_data.get('data') if isinstance(retrieve_data, dict) else {}\n"
"status = (payload_data or {}).get('status')\n"
"versions_block = payload_data.get('versions') if isinstance(payload_data, dict) else {}\n"
"canonical_digest = payload_data.get('canonical_digest') or payload_data.get('digest')\n"
"auth_to_write = None\n"
"def record_versions(vblock):\n"
"    out = {}\n"
"    if isinstance(vblock, dict):\n"
"        cv = vblock.get('client_version')\n"
"        if isinstance(cv, str) and cv.strip():\n"
"            out['client_version'] = cv.strip()\n"
"        wv = vblock.get('wrapper_version')\n"
"        if isinstance(wv, str) and wv.strip():\n"
"            out['wrapper_version'] = wv.strip()\n"
"        ws = vblock.get('wrapper_sha256')\n"
"        if isinstance(ws, str) and ws.strip():\n"
"            out['wrapper_sha256'] = ws.strip()\n"
"        wu = vblock.get('wrapper_url')\n"
"        if isinstance(wu, str) and wu.strip():\n"
"            out['wrapper_url'] = wu.strip()\n"
"    return out\n"
"versions_out = record_versions(versions_block)\n"
"if status == 'valid':\n"
"    auth_to_write = current\n"
"elif status == 'outdated':\n"
"    auth_to_write = payload_data.get('auth') or current\n"
"    lr = payload_data.get('canonical_last_refresh') or payload_data.get('last_refresh')\n"
"    if isinstance(lr, str):\n"
"        auth_to_write['last_refresh'] = lr\n"
"elif status in ('missing', 'upload_required'):\n"
"    pass\n"
"else:\n"
"    status = 'upload_required'\n"
"if status in ('missing', 'upload_required'):\n"
"    store_payload = {'command': 'store','auth': current_for_sync,'client_version': client_version or 'unknown'}\n"
"    if canonical_digest:\n"
"        store_payload['digest'] = canonical_digest\n"
"    if wrapper_version and wrapper_version != 'unknown':\n"
"        store_payload['wrapper_version'] = wrapper_version\n"
"    update_data = post_json(f\"{base}/auth\", store_payload, 'auth store')\n"
"    payload_data = update_data.get('data') if isinstance(update_data, dict) else {}\n"
"    versions_out = record_versions(payload_data.get('versions', {})) or versions_out\n"
"    auth_to_write = payload_data.get('auth') or current\n"
"    lr = payload_data.get('canonical_last_refresh') or payload_data.get('last_refresh')\n"
"    if isinstance(lr, str):\n"
"        auth_to_write['last_refresh'] = lr\n"
"if not isinstance(auth_to_write, dict):\n"
"    auth_to_write = current\n"
"path.parent.mkdir(parents=True, exist_ok=True)\n"
"path.write_text(json.dumps(auth_to_write, indent=2) + '\n', encoding='utf-8')\n"
"try:\n"
"    os.chmod(path, 0o600)\n"
"except PermissionError:\n"
"    pass\n"
"print(json.dumps({'versions': versions_out,'auth_status': status or 'unknown','auth_action': ('store' if status in ('missing','upload_required') else status or 'unknown'),'auth_message': ('synced (no change)' if status == 'valid' else 'updated from api' if status == 'outdated' else 'uploaded current auth' if status in ('missing','upload_required') else status)}, separators=(',', ':')))\n";

static const char *PY_PARSE_VJSON =
"import json, os, sys\n"
"data = os.environ.get('VJSON', '')\n"
"try:\n"
"    parsed = json.loads(data)\n"
"except Exception:\n"
"    sys.exit(0)\n"
"if not isinstance(parsed, dict):\n"
"    sys.exit(0)\n"
"versions = parsed.get('versions') if isinstance(parsed.get('versions'), dict) else {}\n"
"for key, prefix in (('client_version','cv'), ('wrapper_version','wv'), ('wrapper_sha256','ws'), ('wrapper_url','wu')):\n"
"    val = versions.get(key)\n"
"    if isinstance(val, str) and val.strip():\n"
"        print(f\"{prefix}={val.strip()}\")\n"
"for key, prefix in (('auth_status','as'), ('auth_action','aa'), ('auth_message','am')):\n"
"    val = parsed.get(key)\n"
"    if isinstance(val, str) and val.strip():\n"
"        print(f\"{prefix}={val.strip()}\")\n";

static const char *PY_EXTRACT_USAGE =
"import json, pathlib, re, sys\n"
"path = pathlib.Path(sys.argv[1])\n"
"try:\n"
"    content = path.read_text(encoding='utf-8', errors='ignore')\n"
"except Exception:\n"
"    sys.exit(0)\n"
"lines = [ln.strip() for ln in content.splitlines() if 'Token usage' in ln]\n"
"if not lines:\n"
"    sys.exit(0)\n"
"line = lines[-1]\n"
"pattern = re.compile(r\"Token usage:\\s*total=([\\d,]+)\\s+input=([\\d,]+)(?:\\s*\\(\\+\\s*([\\d,]+)\\s*cached\\))?\\s+output=([\\d,]+)\", re.IGNORECASE)\n"
"data = {'line': line}\n"
"match = pattern.search(line)\n"
"if match:\n"
"    def clean(val):\n"
"        return int(val.replace(',', '')) if val else None\n"
"    data['total'] = clean(match.group(1))\n"
"    data['input'] = clean(match.group(2))\n"
"    data['output'] = clean(match.group(4))\n"
"    cached = clean(match.group(3))\n"
"    if cached is not None:\n"
"        data['cached'] = cached\n"
"print(json.dumps(data, separators=(',', ':')))\n";

static const char *PY_POST_USAGE =
"import json, os, ssl, sys, urllib.error, urllib.request\n"
"base = (sys.argv[1] or '').rstrip('/')\n"
"api_key = sys.argv[2]\n"
"payload_raw = sys.argv[3]\n"
"cafile = sys.argv[4] if len(sys.argv) > 4 else ''\n"
"try:\n"
"    payload = json.loads(payload_raw)\n"
"except Exception:\n"
"    sys.exit(1)\n"
"body = json.dumps(payload, separators=(',', ':')).encode('utf-8')\n"
"headers = {'Content-Type': 'application/json', 'X-API-Key': api_key}\n"
"url = f\"{base}/usage\"\n"
"req = urllib.request.Request(url, data=body, headers=headers, method='POST')\n"
"def build_contexts():\n"
"    allow_insecure = os.environ.get('CODEX_SYNC_ALLOW_INSECURE') in ('1','true','TRUE','yes','on')\n"
"    contexts = []\n"
"    try:\n"
"        ctx = ssl.create_default_context()\n"
"        if cafile:\n"
"            ctx.load_verify_locations(cafile)\n"
"        try:\n"
"            ctx.verify_flags &= ~ssl.VERIFY_X509_STRICT\n"
"        except Exception:\n"
"            pass\n"
"        contexts.append(ctx)\n"
"    except Exception:\n"
"        pass\n"
"    if allow_insecure:\n"
"        try:\n"
"            contexts.append(ssl._create_unverified_context())\n"
"        except Exception:\n"
"            pass\n"
"    return contexts or [None]\n"
"def format_summary(data):\n"
"    parts = []\n"
"    for key in ('total','input','output','cached'):\n"
"        if key in data and data[key] is not None:\n"
"            parts.append(f\"{key}={data[key]}\")\n"
"    if not parts and data.get('line'):\n"
"        return data['line']\n"
"    return ' '.join(parts)\n"
"last_err = None\n"
"for ctx in build_contexts():\n"
"    try:\n"
"        with urllib.request.urlopen(req, timeout=10, context=ctx) as resp:\n"
"            resp.read(512)\n"
"            print(format_summary(payload))\n"
"            sys.exit(0)\n"
"    except urllib.error.HTTPError as exc:\n"
"        last_err = f\"HTTP {exc.code}\"\n"
"        continue\n"
"    except Exception as exc:\n"
"        last_err = str(exc)\n"
"        continue\n"
"if last_err:\n"
"    print(last_err, file=sys.stderr)\n"
"sys.exit(1)\n";

static const char *PY_FETCH_RELEASE =
"import json, sys, time, urllib.request\n"
"url = sys.argv[1]\n"
"wanted = sys.argv[2]\n"
"headers = {'Accept': 'application/vnd.github+json','User-Agent': 'codex-wrapper-update-check'}\n"
"try:\n"
"    req = urllib.request.Request(url, headers=headers)\n"
"    with urllib.request.urlopen(req, timeout=15) as resp:\n"
"        data = json.load(resp)\n"
"except Exception as exc:\n"
"    print(f'error: {exc}', file=sys.stderr)\n"
"    sys.exit(1)\n"
"name = data.get('name') or data.get('tag_name') or ''\n"
"assets = data.get('assets') or []\n"
"asset = None\n"
"if wanted:\n"
"    for candidate in assets:\n"
"        if candidate.get('name') == wanted:\n"
"            asset = candidate\n"
"            break\n"
"if asset is None:\n"
"    for candidate in assets:\n"
"        if candidate.get('name') == 'codex':\n"
"            asset = candidate\n"
"            break\n"
"if asset is None:\n"
"    print('error: could not find a matching release asset', file=sys.stderr)\n"
"    sys.exit(2)\n"
"payload = {'timestamp': int(time.time()),'version': name,'tag': data.get('tag_name') or '','asset_name': asset.get('name',''),'download_url': asset.get('browser_download_url','')}\n"
"json.dump(payload, sys.stdout, separators=(',', ':'))\n";

static const char *PY_READ_CACHE =
"import json, sys\n"
"with open(sys.argv[1],'r',encoding='utf-8') as fh:\n"
"    data = json.load(fh)\n"
"print(data.get('version',''))\n"
"print(data.get('download_url',''))\n"
"print(data.get('asset_name',''))\n"
"print(data.get('timestamp',0))\n"
"print(data.get('tag',''))\n";

// Python runner
static int run_python(const char *script, char *const argv[], char **stdout_out) {
    char tmpname[] = "/tmp/cdxpyXXXXXX";
    int fd = mkstemp(tmpname);
    if (fd < 0) return -1;
    FILE *fp = fdopen(fd, "w");
    if (!fp) { close(fd); return -1; }
    fputs(script, fp);
    fclose(fp);

    size_t argc = 0; while (argv && argv[argc]) argc++;
    char **cmdv = calloc(argc + 3, sizeof(char *));
    cmdv[0] = "python3";
    cmdv[1] = tmpname;
    for (size_t i = 0; i < argc; i++) cmdv[i + 2] = argv[i];
    cmdv[argc + 2] = NULL;

    int pipefd[2];
    if (pipe(pipefd) < 0) { unlink(tmpname); free(cmdv); return -1; }
    pid_t pid = fork();
    if (pid == 0) {
        close(pipefd[0]);
        dup2(pipefd[1], STDOUT_FILENO);
        dup2(pipefd[1], STDERR_FILENO);
        close(pipefd[1]);
        execvp(cmdv[0], cmdv);
        _exit(127);
    }
    close(pipefd[1]);
    char *buf = NULL; size_t cap = 0; size_t len = 0;
    char tmp[512];
    ssize_t n;
    while ((n = read(pipefd[0], tmp, sizeof(tmp))) > 0) {
        if (len + n + 1 > cap) { cap = (cap ? cap * 2 : 1024); if (cap < len + n + 1) cap = len + n + 1; buf = realloc(buf, cap); }
        memcpy(buf + len, tmp, n); len += n;
    }
    if (buf) buf[len] = '\0';
    close(pipefd[0]);
    int status; waitpid(pid, &status, 0);
    unlink(tmpname);
    free(cmdv);
    if (stdout_out) *stdout_out = buf; else free(buf);
    if (WIFEXITED(status)) return WEXITSTATUS(status);
    return -1;
}

// Auth helpers -------------------------------------------------------------
static int validate_auth_json_file(const char *path) {
    char *argv[] = {(char *)path, NULL};
    int rc = run_python(PY_VALIDATE_AUTH, argv, NULL);
    return rc == 0;
}

static char *get_auth_last_refresh(const char *path) {
    char *argv[] = {(char *)path, NULL};
    char *out = NULL;
    int rc = run_python(PY_LAST_REFRESH, argv, &out);
    if (rc == 0 && out && *out) return trim(out);
    free(out);
    return NULL;
}

static int sync_auth_with_api(const char *phase) {
    load_sync_config();
    if (!CODEX_SYNC_API_KEY || !*CODEX_SYNC_API_KEY || !CODEX_SYNC_BASE_URL || !*CODEX_SYNC_BASE_URL) {
        if (CODEX_SYNC_OPTIONAL) {
            AUTH_PULL_STATUS = safe_strdup("ok");
            AUTH_STATUS = safe_strdup("skip-sync");
            AUTH_ACTION = safe_strdup("skip");
            AUTH_MESSAGE = safe_strdup("sync skipped (missing API config)");
            return 0;
        }
        AUTH_PULL_STATUS = safe_strdup("missing-config");
        AUTH_PULL_URL = safe_strdup(CODEX_SYNC_BASE_URL ? CODEX_SYNC_BASE_URL : "");
        log_error("auth    | sync config missing API key or base URL; create ~/.codex/sync.env or set CODEX_SYNC_*");
        return 1;
    }
    if (!command_exists("python3")) {
        if (!SYNC_WARNED_NO_PYTHON) {
            log_warn("auth    | python3 required; skipping API sync");
            SYNC_WARNED_NO_PYTHON = 1;
        }
        return 1;
    }
    char auth_path_buf[PATH_MAX];
    snprintf(auth_path_buf, sizeof(auth_path_buf), "%s/.codex/auth.json", getenv("HOME") ? getenv("HOME") : ".");
    char *auth_path = auth_path_buf;
    if (access(auth_path, F_OK) == 0 && !validate_auth_json_file(auth_path)) {
        unlink(auth_path);
    }
    if (access(auth_path, F_OK) != 0) {
        AUTH_PULL_STATUS = safe_strdup("ok");
        AUTH_STATUS = safe_strdup("missing-local");
        AUTH_ACTION = safe_strdup("skip");
        AUTH_MESSAGE = safe_strdup("no local auth; skipping sync");
        return 0;
    }
    char *args[] = { (char *)CODEX_SYNC_BASE_URL, (char *)CODEX_SYNC_API_KEY, auth_path, CODEX_SYNC_CA_FILE ? CODEX_SYNC_CA_FILE : "", LOCAL_VERSION ? LOCAL_VERSION : "unknown", (char *)WRAPPER_VERSION, NULL};
    char *api_output = NULL;
    int rc = run_python(PY_AUTH_SYNC, args, &api_output);
    if (rc == 0 && api_output) {
        log_debug("auth api output: %s", api_output);
        char *envjson = api_output;
        setenv("VJSON", envjson, 1);
        char *parsed = NULL;
        int prc = run_python(PY_PARSE_VJSON, NULL, &parsed);
        unsetenv("VJSON");
        if (prc == 0 && parsed) {
            char *save = NULL;
            for (char *line = strtok_r(parsed, "\n", &save); line; line = strtok_r(NULL, "\n", &save)) {
                if (strncmp(line, "cv=", 3) == 0) SYNC_REMOTE_CLIENT_VERSION = safe_strdup(line + 3);
                else if (strncmp(line, "wv=", 3) == 0) SYNC_REMOTE_WRAPPER_VERSION = safe_strdup(line + 3);
                else if (strncmp(line, "ws=", 3) == 0) SYNC_REMOTE_WRAPPER_SHA256 = safe_strdup(line + 3);
                else if (strncmp(line, "wu=", 3) == 0) SYNC_REMOTE_WRAPPER_URL = safe_strdup(line + 3);
                else if (strncmp(line, "as=", 3) == 0) AUTH_STATUS = safe_strdup(line + 3);
                else if (strncmp(line, "aa=", 3) == 0) AUTH_ACTION = safe_strdup(line + 3);
                else if (strncmp(line, "am=", 3) == 0) AUTH_MESSAGE = safe_strdup(line + 3);
            }
        }
        free(parsed);
        AUTH_PULL_STATUS = safe_strdup("ok");
        AUTH_PULL_URL = safe_strdup(CODEX_SYNC_BASE_URL);
        free(api_output);
        return 0;
    }
    free(api_output);
    switch (rc) {
        case 10:
            log_warn("auth    | sync denied: invalid API key; removing local auth.json");
            unlink(auth_path);
            AUTH_PULL_STATUS = safe_strdup("invalid");
            return 1;
        case 11:
            log_warn("auth    | sync denied: host disabled; removing local auth.json");
            unlink(auth_path);
            return 1;
        case 12:
            log_warn("auth    | sync blocked for this IP (key bound elsewhere); keeping local auth.json.");
            return 1;
        case 21:
        case 22:
            log_warn("auth    | sync failed: API key missing/invalid");
            return 1;
        case 40:
            log_warn("auth    | sync blocked: API disabled by administrator");
            AUTH_PULL_STATUS = safe_strdup("disabled");
            AUTH_PULL_URL = safe_strdup(CODEX_SYNC_BASE_URL);
            return 1;
        default:
            log_warn("auth    | sync %s failed (base=%s, key=%s)", phase ? phase : "sync", CODEX_SYNC_BASE_URL, CODEX_SYNC_API_KEY);
            unlink(auth_path);
            AUTH_PULL_STATUS = safe_strdup("fail");
            AUTH_PULL_URL = safe_strdup(CODEX_SYNC_BASE_URL);
            return 1;
    }
}

// Token usage helpers ------------------------------------------------------
static char *extract_token_usage_payload(const char *log_path) {
    char *argv[] = {(char *)log_path, NULL};
    char *out = NULL;
    int rc = run_python(PY_EXTRACT_USAGE, argv, &out);
    if (rc == 0 && out && *out) return out;
    free(out);
    return NULL;
}

static void post_token_usage_payload(const char *payload_json) {
    if (!payload_json || !*payload_json) return;
    if (!CODEX_SYNC_API_KEY || !CODEX_SYNC_BASE_URL) {
        log_warn("usage   | skipped | API key or base URL missing");
        return;
    }
    char *argv[] = {(char *)CODEX_SYNC_BASE_URL, (char *)CODEX_SYNC_API_KEY, (char *)payload_json, CODEX_SYNC_CA_FILE ? CODEX_SYNC_CA_FILE : "", NULL};
    char *out = NULL;
    int rc = run_python(PY_POST_USAGE, argv, &out);
    if (rc == 0) {
        if (out) { out[strcspn(out, "\n")] = '\0'; log_info("usage   | sent | %s", out); }
    } else {
        log_warn("usage   | failed");
    }
    free(out);
}

// Release helper -----------------------------------------------------------
static int fetch_release_payload(const char *api_url, const char *wanted_asset, char **out_json) {
    char *argv[] = {(char *)api_url, (char *)wanted_asset, NULL};
    return run_python(PY_FETCH_RELEASE, argv, out_json) == 0;
}

static int read_cached_payload(const char *cache_file, char **version, char **url, char **asset, long *timestamp, char **tag) {
    char *argv[] = {(char *)cache_file, NULL};
    char *out = NULL;
    int rc = run_python(PY_READ_CACHE, argv, &out);
    if (rc != 0 || !out) { free(out); return 0; }
    char *save = NULL; int idx = 0;
    for (char *line = strtok_r(out, "\n", &save); line; line = strtok_r(NULL, "\n", &save)) {
        if (idx == 0 && version) *version = safe_strdup(line);
        else if (idx == 1 && url) *url = safe_strdup(line);
        else if (idx == 2 && asset) *asset = safe_strdup(line);
        else if (idx == 3 && timestamp) *timestamp = strtol(line, NULL, 10);
        else if (idx == 4 && tag) *tag = safe_strdup(line);
        idx++;
    }
    free(out);
    return 1;
}

// Update helpers -----------------------------------------------------------
static int perform_update(const char *target_path, const char *url, const char *asset_name, const char *new_version) {
    char tmpdir[] = "/tmp/cdxdlXXXXXX";
    if (!mkdtemp(tmpdir)) return 0;
    char asset_path[PATH_MAX]; snprintf(asset_path, sizeof(asset_path), "%s/asset", tmpdir);
    char cmd[PATH_MAX * 2];
    snprintf(cmd, sizeof(cmd), "curl -fsSL '%s' -o '%s'", url, asset_path);
    if (run_status(cmd) != 0) { log_error("versions | download failed from %s", url); goto cleanup; }
    char extracted[PATH_MAX] = "";
    if (asset_name && strstr(asset_name, ".tar.gz")) {
        snprintf(cmd, sizeof(cmd), "tar -xzf '%s' -C '%s'", asset_path, tmpdir);
        if (run_status(cmd) == 0) {
            char *found = NULL;
            char find_cmd[PATH_MAX * 2];
            snprintf(find_cmd, sizeof(find_cmd), "find '%s' -type f -name 'codex*' | head -n1", tmpdir);
            run_capture(find_cmd, &found);
            if (found && *found) {
                found[strcspn(found, "\n")] = '\0';
                snprintf(extracted, sizeof(extracted), "%s", found);
            }
            free(found);
        }
    } else if (asset_name && strstr(asset_name, ".zip")) {
        snprintf(cmd, sizeof(cmd), "unzip -q '%s' -d '%s'", asset_path, tmpdir);
        if (run_status(cmd) == 0) {
            char *found = NULL;
            char find_cmd[PATH_MAX * 2];
            snprintf(find_cmd, sizeof(find_cmd), "find '%s' -type f -name 'codex*' | head -n1", tmpdir);
            run_capture(find_cmd, &found);
            if (found && *found) {
                found[strcspn(found, "\n")] = '\0';
                snprintf(extracted, sizeof(extracted), "%s", found);
            }
            free(found);
        }
    }
    if (extracted[0] == '\0') {
        snprintf(extracted, sizeof(extracted), "%s/asset-bin", tmpdir);
        snprintf(cmd, sizeof(cmd), "cp '%s' '%s'", asset_path, extracted);
        run_status(cmd);
    }
    chmod(extracted, 0755);
    struct stat st;
    if (stat(extracted, &st) != 0) { log_error("versions | unable to locate Codex binary inside downloaded asset"); goto cleanup; }
    char target_dir[PATH_MAX];
    snprintf(target_dir, sizeof(target_dir), "%s", target_path);
    char *slash = strrchr(target_dir, '/');
    if (slash) *slash = '\0'; else strcpy(target_dir, ".");
    if (access(target_dir, W_OK) == 0) {
        snprintf(cmd, sizeof(cmd), "install -m 755 '%s' '%s'", extracted, target_path);
        if (run_status(cmd) != 0) { log_error("install | failed into %s", target_path); goto cleanup; }
    } else if (CAN_SUDO) {
        snprintf(cmd, sizeof(cmd), "%s install -m 755 '%s' '%s'", SUDO_BIN, extracted, target_path);
        if (run_status(cmd) != 0) { log_warn("install | denied (sudo) for %s", target_path); goto cleanup; }
    } else {
        log_warn("install | insufficient permissions for %s", target_path);
        goto cleanup;
    }
    log_info("versions | codex updated to %s", new_version);
    rmdir(tmpdir);
    return 1;
cleanup:
    char rmcmd[PATH_MAX + 32]; snprintf(rmcmd, sizeof(rmcmd), "rm -rf '%s'", tmpdir);
    run_status(rmcmd);
    return 0;
}

// Run codex and tee output -------------------------------------------------
static int run_codex_command(int argc, char **argv, const char *log_path) {
    int extra = 4; // --ask-for-approval never --sandbox danger-full-access
    char **cmd = calloc(argc + extra + 2, sizeof(char *));
    int idx = 0;
    cmd[idx++] = CODEX_REAL_BIN;
    cmd[idx++] = "--ask-for-approval";
    cmd[idx++] = "never";
    cmd[idx++] = "--sandbox";
    cmd[idx++] = "danger-full-access";
    for (int i = 0; i < argc; i++) cmd[idx++] = argv[i];
    cmd[idx] = NULL;

    int status = 1;
#ifdef __linux__
    if (IS_TTY) {
        int master;
        pid_t pid = forkpty(&master, NULL, NULL, NULL);
        if (pid == 0) {
            execvp(cmd[0], cmd);
            perror("execvp");
            _exit(127);
        }
        FILE *logf = fopen(log_path, "w");
        if (!logf) logf = stdout;
        int done = 0;
        while (!done) {
            fd_set fds; FD_ZERO(&fds); FD_SET(master, &fds); FD_SET(STDIN_FILENO, &fds);
            int maxfd = master > STDIN_FILENO ? master : STDIN_FILENO;
            if (select(maxfd + 1, &fds, NULL, NULL, NULL) < 0) {
                if (errno == EINTR) continue; else break;
            }
            if (FD_ISSET(STDIN_FILENO, &fds)) {
                char buf[4096]; ssize_t n = read(STDIN_FILENO, buf, sizeof(buf));
                if (n > 0) write(master, buf, n);
            }
            if (FD_ISSET(master, &fds)) {
                char buf[4096]; ssize_t n = read(master, buf, sizeof(buf));
                if (n > 0) {
                    fwrite(buf, 1, n, stdout); fflush(stdout);
                    fwrite(buf, 1, n, logf); fflush(logf);
                } else {
                    done = 1;
                }
            }
        }
        int wstatus; waitpid(pid, &wstatus, 0);
        if (logf != stdout) fclose(logf);
        close(master);
        status = WIFEXITED(wstatus) ? WEXITSTATUS(wstatus) : 1;
    } else
#endif
    {
        int pipefd[2];
        if (pipe(pipefd) < 0) { perror("pipe"); free(cmd); return 1; }
        pid_t pid = fork();
        if (pid == 0) {
            close(pipefd[0]);
            dup2(pipefd[1], STDOUT_FILENO);
            dup2(pipefd[1], STDERR_FILENO);
            close(pipefd[1]);
            execvp(cmd[0], cmd);
            perror("execvp");
            _exit(127);
        }
        close(pipefd[1]);
        FILE *logf = fopen(log_path, "w");
        if (!logf) logf = stdout;
        char buffer[4096]; ssize_t n;
        while ((n = read(pipefd[0], buffer, sizeof(buffer))) > 0) {
            fwrite(buffer, 1, n, stdout); fflush(stdout);
            fwrite(buffer, 1, n, logf); fflush(logf);
        }
        if (logf != stdout) fclose(logf);
        close(pipefd[0]);
        int wstatus; waitpid(pid, &wstatus, 0);
        status = WIFEXITED(wstatus) ? WEXITSTATUS(wstatus) : 1;
    }

    free(cmd);
    return status;
}

// Push auth if changed -----------------------------------------------------
static int push_auth_if_changed(const char *phase) {
    char auth_path[PATH_MAX];
    snprintf(auth_path, sizeof(auth_path), "%s/.codex/auth.json", getenv("HOME") ? getenv("HOME") : ".");
    char *refreshed = get_auth_last_refresh(auth_path);
    if ((!ORIGINAL_LAST_REFRESH || !*ORIGINAL_LAST_REFRESH) && (!refreshed || !*refreshed)) {
        AUTH_PUSH_RESULT = safe_strdup("skipped");
        AUTH_PUSH_REASON = safe_strdup("no local auth.json");
        free(refreshed);
        return 0;
    }
    if (refreshed && ORIGINAL_LAST_REFRESH && strcmp(refreshed, ORIGINAL_LAST_REFRESH) == 0) {
        AUTH_PUSH_RESULT = safe_strdup("not-needed");
        AUTH_PUSH_REASON = safe_strdup("auth.json unchanged");
        free(refreshed);
        return 0;
    }
    free(refreshed);
    if (sync_auth_with_api(phase) == 0) {
        SYNC_PUSH_COMPLETED = 1;
        AUTH_PUSH_RESULT = safe_strdup("uploaded");
        AUTH_PUSH_REASON = safe_strdup("auth.json changed");
        return 0;
    }
    AUTH_PUSH_RESULT = safe_strdup("failed");
    AUTH_PUSH_REASON = safe_strdup("api sync error");
    return 1;
}

// Resolve codex binary -----------------------------------------------------
static char *resolve_real_codex(void) {
    char *self = real_path(SCRIPT_REAL);
    const char *prefer[] = {"/usr/local/bin/codex", "/opt/codex/bin/codex", NULL};
    for (int i = 0; prefer[i]; i++) {
        if (access(prefer[i], X_OK) == 0) {
            char *r = real_path(prefer[i]);
            if (strcmp(r, self) != 0) { free(self); return r; }
            free(r);
        }
    }
    char *path = getenv("PATH");
    if (path) {
        char *dup = safe_strdup(path); char *save = NULL;
        for (char *tok = strtok_r(dup, ":", &save); tok; tok = strtok_r(NULL, ":", &save)) {
            if (*tok == '\0') tok = ".";
            char buf[PATH_MAX]; snprintf(buf, sizeof(buf), "%s/codex", tok);
            if (access(buf, X_OK) == 0) {
                char *r = real_path(buf);
                if (strcmp(r, self) != 0) { free(self); free(dup); return r; }
                free(r);
            }
        }
        free(dup);
    }
    free(self);
    return NULL;
}

// Main ---------------------------------------------------------------------
int main(int argc, char **argv) {
    set_colors();
    detect_user();
    detect_privileges();

    int argi = 1;
    for (; argi < argc; argi++) {
        if (strcmp(argv[argi], "--debug") == 0 || strcmp(argv[argi], "--verbose") == 0) {
            CODEX_DEBUG = 1;
            continue;
        }
        if (strcmp(argv[argi], "--allow-insecure-tls") == 0) {
            CODEX_SYNC_ALLOW_INSECURE = 1;
            setenv("CODEX_SYNC_ALLOW_INSECURE", "1", 1);
            continue;
        }
        if (strcmp(argv[argi], "--wrapper-version") == 0 || strcmp(argv[argi], "-W") == 0) {
            printf("cdx wrapper %s\n", WRAPPER_VERSION);
            return 0;
        }
        break;
    }
    int user_argc = argc - argi;
    char **user_argv = argv + argi;

    if (!IS_ROOT && (!CAN_SUDO || strcmp(CURRENT_USER, "chris") != 0)) {
        log_info("system  | non-root; skipping automatic Codex install/update");
    }
    log_debug("starting | user=%s | can_manage=%d | path=%s", CURRENT_USER, CAN_SUDO, getenv("PATH") ? getenv("PATH") : "");

    SCRIPT_REAL = real_path(argv[0]);
    CODEX_REAL_BIN = resolve_real_codex();
    if (!CODEX_REAL_BIN) {
        log_error("system  | unable to find the real Codex binary on PATH");
        return 1;
    }

    char osbuf[64];
    FILE *fp = popen("uname -s", "r"); fgets(osbuf, sizeof(osbuf), fp); pclose(fp); osbuf[strcspn(osbuf, "\n")] = '\0';
    char archbuf[64];
    fp = popen("uname -m", "r"); fgets(archbuf, sizeof(archbuf), fp); pclose(fp); archbuf[strcspn(archbuf, "\n")] = '\0';

    log_info("start   | cdx %s | user %s | %s/%s", WRAPPER_VERSION, CURRENT_USER, osbuf, archbuf);

    int can_manage_codex = IS_ROOT || (CAN_SUDO && strcmp(CURRENT_USER, "chris") == 0);
    if (can_manage_codex && strcmp(osbuf, "Linux") == 0) {
        char *need[] = {"curl", "unzip"};
        ensure_commands(need, 2);
    }

    char *ver_out = NULL;
    run_capture("codex -V 2>/dev/null", &ver_out);
    LOCAL_VERSION = normalize_version(ver_out ? ver_out : "");
    if (!LOCAL_VERSION || !*LOCAL_VERSION) {
        LOCAL_VERSION_UNKNOWN = 1;
        log_warn("versions | local unknown; will try refresh before launch");
    }
    free(ver_out); ver_out = NULL;

    // Early auth + versions sync
    sync_auth_with_api("pull");
    char auth_path[PATH_MAX]; snprintf(auth_path, sizeof(auth_path), "%s/.codex/auth.json", getenv("HOME") ? getenv("HOME") : ".");
    ORIGINAL_LAST_REFRESH = get_auth_last_refresh(auth_path);

    int skip_update_check = !can_manage_codex;
    char asset_name[128] = "";
    if (strcmp(osbuf, "Linux") == 0) {
        if (strcmp(archbuf, "x86_64") == 0 || strcmp(archbuf, "amd64") == 0) {
            char *glibc = detect_glibc_version();
            if (!glibc || version_compare(glibc, "2.39") < 0) {
                strcpy(asset_name, "codex-x86_64-unknown-linux-musl.tar.gz");
                log_info("runtime | glibc %s; using musl Codex build", glibc ? glibc : "unknown");
            } else {
                strcpy(asset_name, "codex-x86_64-unknown-linux-gnu.tar.gz");
            }
            free(glibc);
        } else if (strcmp(archbuf, "aarch64") == 0 || strcmp(archbuf, "arm64") == 0) {
            strcpy(asset_name, "codex-aarch64-unknown-linux-gnu.tar.gz");
        } else {
            log_warn("versions | unsupported arch (%s); skipping update check", archbuf);
            skip_update_check = 1;
        }
    } else {
        log_warn("versions | non-Linux (%s); skipping update check", osbuf);
        skip_update_check = 1;
    }

    const char *API_RELEASES_URL = "https://api.github.com/repos/openai/codex/releases";

    char *remote_version = NULL, *remote_url = NULL, *remote_asset = NULL, *remote_tag = NULL; int need_update = 0; int prefer_npm = 0;
    if (!skip_update_check) {
        if (AUTH_PULL_STATUS && strcmp(AUTH_PULL_STATUS, "ok") == 0 && SYNC_REMOTE_CLIENT_VERSION) {
            remote_version = safe_strdup(SYNC_REMOTE_CLIENT_VERSION);
            remote_tag = safe_strdup(SYNC_REMOTE_CLIENT_VERSION);
        } else if (AUTH_PULL_STATUS && strcmp(AUTH_PULL_STATUS, "ok") == 0) {
            remote_version = safe_strdup(LOCAL_VERSION);
            remote_tag = safe_strdup(LOCAL_VERSION);
        }
    }

    if (!skip_update_check && remote_version) {
        if (LOCAL_VERSION_UNKNOWN) need_update = 1;
        else if (version_compare(LOCAL_VERSION, remote_version) < 0) need_update = 1;
    }

    if (need_update && is_codex_installed_via_npm()) prefer_npm = 1;

    if (need_update && !remote_url && !skip_update_check) {
        char *tmp_payload = NULL;
        const char *tags[5]; int tcount = 0;
        char buf[128];
        tags[tcount++] = remote_tag;
        snprintf(buf, sizeof(buf), "v%s", remote_version); tags[tcount++] = safe_strdup(buf);
        snprintf(buf, sizeof(buf), "rust-%s", remote_version); tags[tcount++] = safe_strdup(buf);
        snprintf(buf, sizeof(buf), "rust-v%s", remote_version); tags[tcount++] = safe_strdup(buf);
        for (int i = 0; i < tcount; i++) {
            if (!tags[i]) continue;
            char url[512]; snprintf(url, sizeof(url), "%s/tags/%s", API_RELEASES_URL, tags[i]);
            if (fetch_release_payload(url, asset_name, &tmp_payload)) {
                char *v = NULL; char *u = NULL; char *a = NULL; long ts = 0; char *tg = NULL;
                char cachefile[] = "/tmp/cdxrelXXXXXX";
                int fd = mkstemp(cachefile);
                if (fd >= 0) {
                    write(fd, tmp_payload, strlen(tmp_payload));
                    close(fd);
                    read_cached_payload(cachefile, &v, &u, &a, &ts, &tg);
                    unlink(cachefile);
                }
                remote_version = v ? v : remote_version;
                remote_url = u;
                remote_asset = a;
                remote_tag = tg ? tg : remote_tag;
                free(tmp_payload);
                break;
            }
            free(tmp_payload); tmp_payload = NULL;
        }
    }

    char version_status[256] = ""; int status_warn = 0;
    if (skip_update_check) {
        snprintf(version_status, sizeof(version_status), "versions | ok | local %s | check skipped (not root)", LOCAL_VERSION ? LOCAL_VERSION : "unknown");
        if (IS_ROOT) status_warn = 1;
    } else if (need_update && remote_url) {
        char display_local[64]; snprintf(display_local, sizeof(display_local), "%s", LOCAL_VERSION ? LOCAL_VERSION : "unknown");
        if (prefer_npm && update_codex_via_npm(remote_version)) {
            run_capture("codex -V 2>/dev/null", &ver_out);
            free(LOCAL_VERSION); LOCAL_VERSION = normalize_version(ver_out ? ver_out : "");
            LOCAL_VERSION_UNKNOWN = 0; free(ver_out);
            snprintf(version_status, sizeof(version_status), "versions | updated | %s → %s (npm codex-cli @%s)", display_local, LOCAL_VERSION, remote_version);
        } else if (perform_update(CODEX_REAL_BIN, remote_url, remote_asset ? remote_asset : asset_name, remote_version)) {
            run_capture("codex -V 2>/dev/null", &ver_out);
            free(LOCAL_VERSION); LOCAL_VERSION = normalize_version(ver_out ? ver_out : "");
            LOCAL_VERSION_UNKNOWN = 0; free(ver_out);
            snprintf(version_status, sizeof(version_status), "versions | updated | %s → %s (from API %s)", display_local, LOCAL_VERSION, remote_tag ? remote_tag : "latest");
        } else {
            status_warn = 1;
            snprintf(version_status, sizeof(version_status), "versions | warn | local %s | update to %s failed", display_local, remote_version);
        }
    } else {
        if (remote_version) {
            snprintf(version_status, sizeof(version_status), "versions | ok | local %s | api %s", LOCAL_VERSION ? LOCAL_VERSION : "unknown", remote_tag ? remote_tag : remote_version);
        } else {
            status_warn = 1;
            snprintf(version_status, sizeof(version_status), "versions | warn | local %s | API unavailable", LOCAL_VERSION ? LOCAL_VERSION : "unknown");
        }
    }
    if (status_warn) log_warn("%s", version_status); else log_info("%s", version_status);

    // Wrapper self-update
    const char *target_wrapper = SYNC_REMOTE_WRAPPER_VERSION ? SYNC_REMOTE_WRAPPER_VERSION : WRAPPER_VERSION;
    int need_wrapper = target_wrapper && strcmp(target_wrapper, WRAPPER_VERSION) != 0;
    if (!need_wrapper && SYNC_REMOTE_WRAPPER_SHA256 && access(SCRIPT_REAL, R_OK) == 0) {
        char cmd[PATH_MAX]; snprintf(cmd, sizeof(cmd), "sha256sum '%s' | awk '{print $1}'", SCRIPT_REAL);
        char *sha_out = NULL; run_capture(cmd, &sha_out);
        if (sha_out && strcmp(trim(sha_out), SYNC_REMOTE_WRAPPER_SHA256) != 0) need_wrapper = 1;
        free(sha_out);
    }
    if (AUTH_PULL_STATUS && strcmp(AUTH_PULL_STATUS, "ok") == 0 && need_wrapper && SYNC_REMOTE_WRAPPER_URL) {
        char full_url[PATH_MAX];
        if (strncmp(SYNC_REMOTE_WRAPPER_URL, "http", 4) == 0) snprintf(full_url, sizeof(full_url), "%s", SYNC_REMOTE_WRAPPER_URL);
        else snprintf(full_url, sizeof(full_url), "%s%s", CODEX_SYNC_BASE_URL, SYNC_REMOTE_WRAPPER_URL);
        char tmpdir[] = "/tmp/cdxwrapXXXXXX"; mkdtemp(tmpdir);
        char tmpfile[PATH_MAX]; snprintf(tmpfile, sizeof(tmpfile), "%s/cdx", tmpdir);
        char cmd[PATH_MAX * 2];
        snprintf(cmd, sizeof(cmd), "curl -fsSL -H 'X-API-Key: %s' %s '%s' -o '%s'", CODEX_SYNC_API_KEY, CODEX_SYNC_CA_FILE ? "--cacert" : "", CODEX_SYNC_CA_FILE ? CODEX_SYNC_CA_FILE : "", tmpfile);
        if (run_status(cmd) == 0) {
            if (SYNC_REMOTE_WRAPPER_SHA256) {
                char sha_cmd[PATH_MAX * 2]; snprintf(sha_cmd, sizeof(sha_cmd), "sha256sum '%s' | awk '{print $1}'", tmpfile);
                char *sha_out = NULL; run_capture(sha_cmd, &sha_out);
                if (!sha_out || strcmp(trim(sha_out), SYNC_REMOTE_WRAPPER_SHA256) != 0) {
                    log_warn("wrapper | update skipped: hash mismatch");
                } else {
                    if (access(SCRIPT_REAL, W_OK) == 0) {
                        char install_cmd[PATH_MAX * 2]; snprintf(install_cmd, sizeof(install_cmd), "install -m 755 '%s' '%s'", tmpfile, SCRIPT_REAL);
                        run_status(install_cmd);
                    } else if (CAN_SUDO) {
                        char install_cmd[PATH_MAX * 2]; snprintf(install_cmd, sizeof(install_cmd), "%s install -m 755 '%s' '%s'", SUDO_BIN, tmpfile, SCRIPT_REAL);
                        run_status(install_cmd);
                    } else log_warn("wrapper | update skipped: insufficient permissions");
                }
                free(sha_out);
            }
        } else {
            log_warn("wrapper | update failed: download error");
        }
        char rmcmd[PATH_MAX]; snprintf(rmcmd, sizeof(rmcmd), "rm -rf '%s'", tmpdir); run_status(rmcmd);
    }

    if (AUTH_PULL_STATUS && strcmp(AUTH_PULL_STATUS, "ok") == 0) {
        char *codex_state = NULL; char *cdx_state = NULL;
        const char *target_version = remote_tag ? remote_tag : (remote_version ? remote_version : (LOCAL_VERSION ? LOCAL_VERSION : "unknown"));
        if (LOCAL_VERSION && strcmp(LOCAL_VERSION, target_version) != 0) {
            size_t len = strlen(target_version) + strlen(LOCAL_VERSION) + 32;
            codex_state = malloc(len); snprintf(codex_state, len, "needs update (%s, local %s)", target_version, LOCAL_VERSION);
        } else {
            size_t len = strlen(LOCAL_VERSION ? LOCAL_VERSION : "unknown") + 16;
            codex_state = malloc(len); snprintf(codex_state, len, "current (%s)", LOCAL_VERSION ? LOCAL_VERSION : "unknown");
        }
        size_t len = strlen(WRAPPER_VERSION) + (target_wrapper ? strlen(target_wrapper) : 0) + 32;
        cdx_state = malloc(len); snprintf(cdx_state, len, "current (%s/%s)", WRAPPER_VERSION, target_wrapper ? target_wrapper : WRAPPER_VERSION);
        if (AUTH_STATUS || AUTH_ACTION || AUTH_MESSAGE) {
            const char *message = AUTH_MESSAGE ? AUTH_MESSAGE : "ok";
            log_info("auth    | %s | action=%s | %s", AUTH_STATUS ? AUTH_STATUS : "ok", AUTH_ACTION ? AUTH_ACTION : "n/a", message);
        }
        char summary[256]; snprintf(summary, sizeof(summary), "health  | api ok | codex %s | cdx %s", codex_state, cdx_state);
        log_info("%s", summary);
        free(codex_state); free(cdx_state);
    } else {
        char summary[256]; snprintf(summary, sizeof(summary), "health  | api fail | codex auth unavailable | cdx current (%s/%s)", WRAPPER_VERSION, SYNC_REMOTE_WRAPPER_VERSION ? SYNC_REMOTE_WRAPPER_VERSION : WRAPPER_VERSION);
        log_warn("%s", summary);
        log_error("health  | auth unavailable; refusing to start Codex until sync succeeds");
        return 1;
    }

    // Run Codex
    char tmp_log[] = "/tmp/cdx-runXXXXXX"; int fd = mkstemp(tmp_log); if (fd >= 0) close(fd); else strcpy(tmp_log, "/tmp/cdx-run.log");
    int cmd_status = run_codex_command(user_argc, user_argv, tmp_log);

    char *usage_payload = extract_token_usage_payload(tmp_log);
    if (usage_payload) { post_token_usage_payload(usage_payload); free(usage_payload); }
    unlink(tmp_log);

    push_auth_if_changed("push");
    if (AUTH_PUSH_RESULT) log_info("push    | auth | %s | %s", AUTH_PUSH_RESULT, AUTH_PUSH_REASON ? AUTH_PUSH_REASON : "n/a");

    return cmd_status;
}
