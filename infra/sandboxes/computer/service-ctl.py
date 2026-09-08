#!/usr/bin/env python3
"""rakazo-service-ctl: supervised project service control inside a computer container.

Speaks to the distro supervisord XML-RPC interface on 127.0.0.1. Every command
is a single JSON document on stdin and a single JSON document on stdout, so the
supervisor host (and the machine tunnel) never touch a shell here. Service argv
is exec'd by supervisord directly — no shell interpretation anywhere.

Subcommands: up, list, stop, restart, remove, probe, http.
Exit codes: 0 ok, 1 usage/runtime error, 2 supervisord unreachable (unsupported).
"""

import base64
import json
import os
import re
import shlex
import sys
import urllib.error
import urllib.request
import uuid
import xmlrpc.client

SUPERVISOR_URL = "http://127.0.0.1:9011/RPC2"
SERVICES_DIR = "/etc/rakazo/services.d"
NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


def allowed_port(port):
    # Keep the adapter translation aligned with contracts/src/services.ts.
    return (
        isinstance(port, int) and 1024 <= port <= 65535
        and port not in {7070, 9011}
        and not 5900 <= port <= 5915
        and not 6080 <= port <= 6095
    )

class ControlError(Exception):
    pass


class Unsupported(Exception):
    pass


def read_stdin_json():
    try:
        raw = sys.stdin.read()
        data = json.loads(raw or "{}")
    except json.JSONDecodeError as error:
        raise ControlError(f"invalid JSON request: {error}")
    if not isinstance(data, dict):
        raise ControlError("request must be a JSON object")
    return data


def supervisor():
    try:
        return xmlrpc.client.ServerProxy(SUPERVISOR_URL, allow_none=True).supervisor
    except Exception as error:
        raise Unsupported(f"supervisord unreachable: {error}")


def check_name(name):
    if not isinstance(name, str) or not NAME_PATTERN.match(name):
        raise ControlError(f"invalid service name: {name!r}")
    return name


def conf_path(name):
    return os.path.join(SERVICES_DIR, f"{name}.conf")


def conf_escape(value):
    """Escape a value for a supervisord conf double-quoted string.

    Percent signs double so supervisord's %(ENV_x)s expansion pass leaves
    the value untouched.
    """
    return (
        value.replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("%", "%%")
        .replace("\n", " ")
        .replace("\r", " ")
    )


def render_conf(spec):
    """Render one service as a supervisord program.

    The command line is argv-quoted with shlex.quote: supervisord splits it
    with shlex and exec's argv directly, so no shell ever interprets it.
    Literal percent signs are doubled to survive supervisord's %(ENV_x)s
    expansion pass.
    """
    name = check_name(spec["name"])
    argv = spec["argv"]
    if not isinstance(argv, list) or not argv or len(argv) > 32:
        raise ControlError("argv must be a non-empty list of at most 32 entries")
    for entry in argv:
        if not isinstance(entry, str) or not entry or len(entry) > 4096:
            raise ControlError("argv entries must be strings of 1..4096 chars")
    command = " ".join(shlex.quote(part).replace("%", "%%") for part in argv)
    directory = spec["cwd"]
    if not isinstance(directory, str) or not directory.startswith("/home/rakazo") or ".." in directory:
        raise ControlError("service cwd must be inside the computer home")
    env = spec.get("env") or {}
    if not isinstance(env, dict) or len(env) > 32:
        raise ControlError("env must be an object of at most 32 entries")
    for key, value in env.items():
        if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            raise ControlError(f"invalid environment name: {key!r}")
        if not isinstance(value, str) or len(value) > 8192:
            raise ControlError(f"invalid environment value for {key}")
    ports = spec.get("ports") or []
    if not isinstance(ports, list) or len(ports) > 8:
        raise ControlError("ports must be a list of at most 8 entries")
    for port in ports:
        if not allowed_port(port):
            raise ControlError(f"port out of range: {port!r}")
    keep_alive = bool(spec.get("keepAlive"))
    # RAKAZO_* environment names are reserved for declared metadata.
    user_env = {key: value for key, value in env.items() if not key.startswith("RAKAZO_")}
    env_pairs = ",".join(f'{key}="{conf_escape(str(value))}"' for key, value in sorted(user_env.items()))
    meta_pairs = ",".join(
        [
            'HOME="/home/rakazo"',
            f'RAKAZO_PORTS="{":".join(str(port) for port in ports)}"',
            f'RAKAZO_KEEPALIVE="{1 if keep_alive else 0}"',
        ]
    )
    program = f"rakazo-{name}"
    lines = [
        f"[program:{program}]",
        f"command={command}",
        f"directory={directory}",
        "autostart=false",
        "autorestart=true",
        "startsecs=1",
        "startretries=3",
        "stopasgroup=true",
        "killasgroup=true",
        "stopsignal=TERM",
        "stopwaitsecs=10",
        f"environment={meta_pairs},{env_pairs}" if env_pairs else f"environment={meta_pairs}",
        f"stdout_logfile=/tmp/rakazo/services-{program}.log",
        "stdout_logfile_maxbytes=5MB",
        "stdout_logfile_backups=1",
        f"stderr_logfile=/tmp/rakazo/services-{program}.err.log",
        "stderr_logfile_maxbytes=5MB",
        "stderr_logfile_backups=1",
    ]
    return "\n".join(lines) + "\n"


def read_meta(name):
    """Declared ports/keepAlive/cwd/revision live in a JSON sidecar beside the conf."""
    path = os.path.join(SERVICES_DIR, f"{name}.json")
    if not os.path.isfile(path):
        return {"ports": [], "keepAlive": False, "cwd": "", "revision": ""}
    try:
        with open(path, encoding="utf-8") as handle:
            meta = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return {"ports": [], "keepAlive": False, "cwd": "", "revision": ""}
    return {
        "ports": meta.get("ports") if isinstance(meta.get("ports"), list) else [],
        "keepAlive": meta.get("keepAlive") is True,
        "cwd": meta.get("cwd") if isinstance(meta.get("cwd"), str) else "",
        "revision": meta.get("revision") if isinstance(meta.get("revision"), str) else "",
    }


def status_of(state):
    return {
        "RUNNING": "running",
        "STOPPED": "stopped",
        "EXITED": "exited",
        "FATAL": "fatal",
    }.get(state, "unknown")


def list_services(rpc):
    try:
        infos = rpc.getAllProcessInfo()
    except Exception as error:
        raise Unsupported(f"supervisord unreachable: {error}")
    services = []
    for name, info in sorted(infos.items()):
        if not name.startswith("rakazo-"):
            continue
        short = name[len("rakazo-"):]
        meta = read_meta(short)
        services.append(
            {
                "name": short,
                "status": status_of(info.get("statename", "")),
                "pid": info.get("pid") or None,
                "ports": meta["ports"],
                "keepAlive": meta["keepAlive"],
                "cwd": meta["cwd"],
                "revision": meta["revision"],
            }
        )
    return {"supported": True, "services": services}


def write_conf(spec):
    name = check_name(spec["name"])
    os.makedirs(SERVICES_DIR, exist_ok=True)
    meta = {
        "ports": spec.get("ports") or [],
        "keepAlive": bool(spec.get("keepAlive")),
        "cwd": spec["cwd"],
        # Declaration-instance nonce: preview tokens bind it so a removed and
        # re-declared service with the same name and ports revokes old links.
        "revision": uuid.uuid4().hex,
    }
    tmp = conf_path(name) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        handle.write(render_conf(spec))
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, conf_path(name))
    os.chmod(conf_path(name), 0o644)
    meta_path = os.path.join(SERVICES_DIR, f"{name}.json")
    meta_tmp = meta_path + ".tmp"
    with open(meta_tmp, "w", encoding="utf-8") as handle:
        json.dump(meta, handle)
    os.replace(meta_tmp, meta_path)
    os.chmod(meta_path, 0o644)


def apply_and_start(rpc, name):
    rpc.reread()
    rpc.update()
    group = f"rakazo-{name}"
    try:
        info = rpc.getProcessInfo(group)
    except Exception:
        raise ControlError(f"service {name} did not register")
    if info.get("statename") != "RUNNING":
        rpc.startProcess(group)


def cmd_up(rpc, spec):
    name = check_name(spec.get("name"))
    write_conf(spec)
    apply_and_start(rpc, name)
    return {"ok": True}


def cmd_stop(rpc, spec):
    name = check_name(spec.get("name"))
    try:
        rpc.stopProcess(f"rakazo-{name}")
    except xmlrpc.client.Fault as error:
        if "NOT_RUNNING" not in str(error):
            raise
    return {"ok": True}


def cmd_restart(rpc, spec):
    name = check_name(spec.get("name"))
    rpc.stopProcess(f"rakazo-{name}")
    rpc.startProcess(f"rakazo-{name}")
    return {"ok": True}


def cmd_remove(rpc, spec):
    name = check_name(spec.get("name"))
    try:
        rpc.stopProcess(f"rakazo-{name}")
    except xmlrpc.client.Fault as error:
        if "NOT_RUNNING" not in str(error):
            raise
    path = conf_path(name)
    if os.path.isfile(path):
        os.remove(path)
    meta_path = os.path.join(SERVICES_DIR, f"{name}.json")
    if os.path.isfile(meta_path):
        os.remove(meta_path)
    rpc.reread()
    rpc.update()
    return {"ok": True}


def cmd_probe(rpc, _spec):
    """Idle probe: exit 0 when a kept service is running, 1 when none is."""
    for service in list_services(rpc)["services"]:
        if service["keepAlive"] and service["status"] == "running":
            return {"kept": True}
    print("rakazo-services-idle")
    sys.exit(1)


def cmd_http(rpc, spec):
    """Fetch a preview from 127.0.0.1:<port> inside this container.

    Returns status/contentType/bodyBase64; never follows redirects so the
    supervisor proxy can rewrite same-host redirects without leaking anything.
    """
    port = spec.get("port")
    if not allowed_port(port):
        raise ControlError(f"invalid preview port: {port!r}")
    check_name(spec.get("name", ""))
    max_bytes = spec.get("maxBytes", 8 * 1024 * 1024)
    if not isinstance(max_bytes, int) or max_bytes <= 0 or max_bytes > 8 * 1024 * 1024:
        raise ControlError("invalid maxBytes")
    path = spec.get("path") or "/"
    if not path.startswith("/") or ".." in path or len(path) > 2048:
        raise ControlError("invalid preview path")
    query = spec.get("query") or ""
    method = spec.get("method", "GET")
    if method not in ("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"):
        raise ControlError(f"preview method not allowed: {method}")
    url = f"http://127.0.0.1:{port}{path}" + (f"?{query}" if query else "")
    body = None
    headers = {}
    content_type = spec.get("contentType")
    if content_type and re.fullmatch(r"[!-~]{1,200}", content_type):
        headers["Content-Type"] = content_type
    raw = spec.get("bodyBase64")
    if raw:
        body = base64.b64decode(raw)
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    opener = urllib.request.build_opener(NoRedirect())
    try:
        with opener.open(request, timeout=15) as response:
            payload = response.read(max_bytes + 1)
            status = response.status
            response_type = response.headers.get("Content-Type")
            location = response.headers.get("Location") if response.headers else None
    except urllib.error.HTTPError as error:
        payload = error.read(max_bytes + 1)
        status = error.code
        response_type = error.headers.get("Content-Type") if error.headers else None
        location = error.headers.get("Location") if error.headers else None
    if len(payload) > max_bytes:
        raise ControlError("preview response exceeds the bound")
    return {
        "status": status,
        "contentType": response_type,
        "bodyBase64": base64.b64encode(payload).decode("ascii") if payload else None,
        "location": location if isinstance(location, str) and len(location) <= 2048 else None,
    }


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def main():
    if len(sys.argv) != 2:
        print("usage: rakazo-service-ctl SUBCOMMAND", file=sys.stderr)
        return 1
    subcommand = sys.argv[1]
    rpc = supervisor()
    spec = read_stdin_json()
    handlers = {
        "up": cmd_up,
        "list": lambda rpc, spec: list_services(rpc),
        "stop": cmd_stop,
        "restart": cmd_restart,
        "remove": cmd_remove,
        "probe": cmd_probe,
        "http": cmd_http,
    }
    handler = handlers.get(subcommand)
    if handler is None:
        raise ControlError(f"unknown subcommand: {subcommand}")
    result = handler(rpc, spec)
    if result is not None:
        json.dump(result, sys.stdout)
        sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Unsupported as error:
        print(str(error), file=sys.stderr)
        sys.exit(2)
    except (ControlError, xmlrpc.client.Fault, OSError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
