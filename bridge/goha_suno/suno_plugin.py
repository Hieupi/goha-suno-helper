"""Plugins: one installation adds its own job lists and MCP tools to the bridge.

A community install has none. Set `GOHA_SUNO_PLUGIN` to the path of a `.py` file and
the bridge imports it at start and calls its `create_plugin()`, which returns a
`Plugin` (subclass this one; override only what is needed):

  claims(name) -> bool            which job-list names it owns (e.g. `EP008`); everything
                                  else is a project (`suno_projects.py`)
  job_file(name) -> Path          where a claimed name's job list is saved; the folder's name
                                  keys the list (queue picture, remembered download folder)
  job_files() -> Iterable[Path]   its job lists to load at start (lost work becomes `unknown`)
  title_ok(store, job, stem)      whether a finished download's file name is the right song;
                                  None leaves the core's own check (the job's expected title)
  on_result(core, store, job)     after a result for one of its jobs was recorded and saved;
                                  a failure raised here is kept on the job and alerted
  instructions                    text appended to the MCP server's instructions
  register_tools(server, core, bridge)   adds its own MCP tools (`@server.tool()`)

A plugin plans jobs of the four kinds in `suno_jobs.py` and queues them with
`core.add_jobs(core.store(name), planned)`. Pairing, the queue, the protocol and every
credit-safety rule stay the core's: a plugin cannot loosen them.
"""

from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path
from typing import Iterable, Mapping

PLUGIN_ENV = "GOHA_SUNO_PLUGIN"
MODULE_NAME = "goha_suno_plugin"


class PluginError(RuntimeError):
    """The configured plugin cannot be loaded."""


class Plugin:
    """Claims nothing and adds nothing; subclasses override what they need."""

    instructions = ""

    def claims(self, name: str) -> bool:
        return False

    def job_file(self, name: str) -> Path:
        raise KeyError(name)

    def job_files(self) -> Iterable[Path]:
        return ()

    def title_ok(self, store, job, stem: str) -> bool | None:
        return None

    def on_result(self, core, store, job) -> None:
        return None

    def register_tools(self, server, core, bridge) -> None:
        return None


def load_plugin(environ: Mapping[str, str] | None = None) -> Plugin | None:
    """The plugin `GOHA_SUNO_PLUGIN` names, or None when the variable is unset."""
    value = (os.environ if environ is None else environ).get(PLUGIN_ENV, "").strip().strip('"')
    if not value:
        return None
    path = Path(value).expanduser()
    if not path.is_file():
        raise PluginError(f"{PLUGIN_ENV}: không có file {path}")
    spec = importlib.util.spec_from_file_location(MODULE_NAME, path)
    if spec is None or spec.loader is None:
        raise PluginError(f"{PLUGIN_ENV}: {path} không phải file Python")
    module = importlib.util.module_from_spec(spec)
    sys.modules[MODULE_NAME] = module  # dataclasses and pickling look a module up by name
    try:
        spec.loader.exec_module(module)
        factory = getattr(module, "create_plugin", None)
        if not callable(factory):
            raise PluginError(f"{path} thiếu hàm create_plugin()")
        plugin = factory()
    except PluginError:
        sys.modules.pop(MODULE_NAME, None)
        raise
    except Exception as error:  # noqa: BLE001 - whatever the plugin raises, say which file and why
        sys.modules.pop(MODULE_NAME, None)
        raise PluginError(f"không nạp được plugin {path}: {type(error).__name__}: {error}") from error
    if not isinstance(plugin, Plugin):
        raise PluginError(f"{path}: create_plugin() phải trả về một goha_suno.suno_plugin.Plugin")
    return plugin
