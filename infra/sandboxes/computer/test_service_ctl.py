"""Offline tests for rakazo-service-ctl conf rendering and validation.

Run with: python3 infra/sandboxes/computer/test_service_ctl.py
Pure unit tests: no supervisord, docker, or network required.
"""

import importlib.util
import json
import os
import shlex
import tempfile
import unittest
from unittest import mock

SPEC_PATH = os.path.join(os.path.dirname(__file__), "service-ctl.py")
_SPEC = importlib.util.spec_from_file_location("service_ctl", SPEC_PATH)
ctl = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(ctl)


def base_spec():
    return {
        "name": "web",
        "argv": ["npm", "run", "dev"],
        "cwd": "/home/rakazo/bots/b1/app",
        "env": {"PORT": "3000"},
        "ports": [3000],
        "keepAlive": True,
    }


class RenderConfTest(unittest.TestCase):
    def test_control_ports_are_never_preview_ports(self):
        for port in [7070, 9011, *range(5900, 5916), *range(6080, 6096)]:
            spec = base_spec()
            spec["ports"] = [port]
            with self.assertRaises(ctl.ControlError):
                ctl.render_conf(spec)
            self.assertFalse(ctl.allowed_port(port))


    def test_renders_quoted_argv_and_kept_metadata(self):
        conf = ctl.render_conf(base_spec())
        self.assertIn("[program:rakazo-web]", conf)
        self.assertIn("command=npm run dev", conf)
        self.assertIn('RAKAZO_PORTS="3000"', conf)
        self.assertIn('RAKAZO_KEEPALIVE="1"', conf)
        self.assertIn("autostart=false", conf)
        self.assertIn("autorestart=true", conf)
        self.assertIn("stopasgroup=true", conf)

    def test_argv_with_shell_metacharacters_stays_argv_quoted(self):
        spec = base_spec()
        script = "echo hi $HOME; rm -rf /; echo 'q\"uote'"
        spec["argv"] = ["bash", "-c", script]
        conf = ctl.render_conf(spec)
        command_line = next(line for line in conf.splitlines() if line.startswith("command="))
        # No shell interprets anything here: the whole script stays ONE
        # shlex-quoted argv element, consumed by supervisord's exec.
        self.assertEqual(command_line, f"command=bash -c {shlex.quote(script)}")

    def test_percent_signs_are_doubled(self):
        spec = base_spec()
        spec["argv"] = ["echo", "100%"]
        spec["env"] = {"V": "a%b"}
        conf = ctl.render_conf(spec)
        self.assertIn("command=echo 100%%", conf)
        self.assertIn('V="a%%b"', conf)

    def test_reserved_env_names_are_filtered(self):
        spec = base_spec()
        spec["env"] = {"RAKAZO_PORTS": "9999", "OK": "1"}
        conf = ctl.render_conf(spec)
        self.assertNotIn("9999", conf)
        self.assertIn('OK="1"', conf)

    def test_rejects_bad_name(self):
        for name in ["", "../evil", "UPPER", "a b", "x" * 65, None, 7]:
            spec = base_spec()
            spec["name"] = name
            with self.assertRaises(ctl.ControlError):
                ctl.render_conf(spec)

    def test_rejects_outside_home_cwd(self):
        spec = base_spec()
        spec["cwd"] = "/etc"
        with self.assertRaises(ctl.ControlError):
            ctl.render_conf(spec)

    def test_rejects_relative_escape(self):
        spec = base_spec()
        spec["cwd"] = "/home/rakazo/../etc"
        with self.assertRaises(ctl.ControlError):
            ctl.render_conf(spec)

    def test_rejects_bad_ports(self):
        for port in [80, 70000, "3000", None]:
            spec = base_spec()
            spec["ports"] = [port]
            with self.assertRaises(ctl.ControlError):
                ctl.render_conf(spec)

    def test_rejects_too_many_env_entries(self):
        spec = base_spec()
        spec["env"] = {f"K{i}": "v" for i in range(33)}
        with self.assertRaises(ctl.ControlError):
            ctl.render_conf(spec)


class WriteAndListTest(unittest.TestCase):
    def test_write_conf_and_sidecar_then_list_reports_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.object(ctl, "SERVICES_DIR", directory):
                ctl.write_conf(base_spec())
                conf_text = open(os.path.join(directory, "web.conf"), encoding="utf-8").read()
                self.assertIn("[program:rakazo-web]", conf_text)
                meta = json.load(open(os.path.join(directory, "web.json"), encoding="utf-8"))
                self.assertEqual(meta["ports"], [3000])
                self.assertTrue(meta["keepAlive"])
                self.assertEqual(meta["cwd"], "/home/rakazo/bots/b1/app")
                # Declaration-instance nonce: preview tokens bind it so a
                # removed and re-declared service revokes outstanding links.
                self.assertRegex(meta["revision"], r"^[0-9a-f]{32}$")
                self.assertEqual(ctl.read_meta("web")["ports"], [3000])
                self.assertEqual(
                    ctl.read_meta("missing"),
                    {"ports": [], "keepAlive": False, "cwd": "", "revision": ""},
                )

    def test_conf_write_is_atomic_and_does_not_leave_tmp(self):
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.object(ctl, "SERVICES_DIR", directory):
                ctl.write_conf(base_spec())
                self.assertEqual([p for p in os.listdir(directory) if p.endswith(".tmp")], [])


class ListServicesTest(unittest.TestCase):
    def test_list_filters_non_rakazo_and_maps_status(self):
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.object(ctl, "SERVICES_DIR", directory):
                ctl.write_conf(base_spec())
                infos = {
                    "rakazo-web": {"statename": "RUNNING", "pid": 42},
                    "fluxbox": {"statename": "RUNNING", "pid": 7},
                    "rakazo-api": {"statename": "FATAL", "pid": 0},
                }
                rpc = mock.Mock()
                rpc.getAllProcessInfo.return_value = infos
                meta_revision = ctl.read_meta("web")["revision"]
                payload = ctl.list_services(rpc)
                self.assertTrue(payload["supported"])
                names = [service["name"] for service in payload["services"]]
                self.assertEqual(names, ["api", "web"])
                web = payload["services"][1]
                self.assertEqual(web["status"], "running")
                self.assertEqual(web["pid"], 42)
                self.assertEqual(web["ports"], [3000])
                self.assertEqual(web["revision"], meta_revision)
                api = payload["services"][0]
                self.assertEqual(api["status"], "fatal")
                self.assertIsNone(api["pid"])

    def test_list_unsupported_when_supervisord_down(self):
        rpc = mock.Mock()
        rpc.getAllProcessInfo.side_effect = OSError("no supervisord")
        with self.assertRaises(ctl.Unsupported):
            ctl.list_services(rpc)


class ProbeTest(unittest.TestCase):
    def test_probe_idle_exits_one(self):
        rpc = mock.Mock()
        rpc.getAllProcessInfo.return_value = {}
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.object(ctl, "SERVICES_DIR", directory):
                with self.assertRaises(SystemExit) as caught:
                    ctl.cmd_probe(rpc, {})
                self.assertEqual(caught.exception.code, 1)

    def test_probe_kept_service_running_reports_busy(self):
        rpc = mock.Mock()
        rpc.getAllProcessInfo.return_value = {}
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.object(ctl, "SERVICES_DIR", directory):
                ctl.write_conf(base_spec())
                with mock.patch.object(
                    ctl,
                    "list_services",
                    return_value={
                        "supported": True,
                        "services": [{"name": "web", "status": "running", "keepAlive": True, "ports": [3000], "pid": 5, "cwd": "/home/rakazo/app"}],
                    },
                ):
                    self.assertEqual(ctl.cmd_probe(rpc, {}), {"kept": True})


class HttpTest(unittest.TestCase):
    def test_rejects_bad_method_port_and_path(self):
        for patch_spec in [
            {"method": "TRACE"},
            {"port": 80},
            {"path": "/../etc/passwd"},
            {"maxBytes": 1 << 30},
        ]:
            spec = {"name": "web", "port": 3000, "path": "/", "method": "GET"}
            spec.update(patch_spec)
            with self.assertRaises(ctl.ControlError):
                ctl.cmd_http(mock.Mock(), spec)

    def test_http_returns_status_and_content(self):
        captured = {}

        class FakeResponse:
            status = 200
            headers = {"Content-Type": "text/html"}

            def read(self, _n):
                return b"<html>ok</html>"

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        def fake_open(request, timeout):
            captured["url"] = request.full_url
            captured["method"] = request.get_method()
            return FakeResponse()

        with mock.patch.object(ctl.urllib.request, "OpenerDirector"):
            with mock.patch.object(ctl.urllib.request, "build_opener") as build:
                build.return_value.open.side_effect = fake_open
                payload = ctl.cmd_http(
                    mock.Mock(),
                    {"name": "web", "port": 3000, "path": "/x", "query": "a=1", "method": "GET"},
                )
        self.assertEqual(captured["url"], "http://127.0.0.1:3000/x?a=1")
        self.assertEqual(captured["method"], "GET")
        self.assertEqual(payload["status"], 200)
        self.assertEqual(payload["contentType"], "text/html")

    def test_http_does_not_follow_redirects(self):
        class FakeRedirect(ctl.urllib.error.HTTPError):
            def __init__(self):
                super().__init__("url", 302, "found", {"Content-Type": "text/html"}, None)

            def read(self, _n):
                return b""

        with mock.patch.object(ctl.urllib.request, "build_opener") as build:
            build.return_value.open.side_effect = lambda request, timeout: (_ for _ in ()).throw(FakeRedirect())
            payload = ctl.cmd_http(
                mock.Mock(),
                {"name": "web", "port": 3000, "path": "/", "method": "GET"},
            )
        self.assertEqual(payload["status"], 302)


if __name__ == "__main__":
    unittest.main(verbosity=2)
