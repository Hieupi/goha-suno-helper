"""Validate Suno input packets (packet contract v2, D022).

A packet states project intent (`instrumental: true`, `project_mode:
full_control`); the adapter maps that intent onto whatever the Suno UI exposes
today. This module checks that a packet is complete, that every value sits
inside the platform limits recorded in `10_SUNO_INPUT_SCHEMA.yaml`, and that
the intent fields are consistent with their mapped fields (an instrumental
packet has an empty Lyrics box).

Platform limits produce ERROR; project policy produces WARNING. The numbers
are read from the schema so they are defined in exactly one place.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Iterator

import yaml

from scripts.validation_types import (
    ERROR,
    WARNING,
    WARNING_STRONG,
    Finding,
    iter_yaml_files,
)

SUNO_SCHEMA_REL = "knowledge/suno/10_SUNO_INPUT_SCHEMA.yaml"

# Every UI control must be declared explicitly, even when its value is
# "off" or null. AGENTS.md requires the Magic Wand / My Taste state too.
SUNO_REQUIRED_FIELDS = {
    "model",
    "project_mode",
    "suno_ui_tab",
    "instrumental",
    "lyrics",
    "title",
    "duration_mode",
    "duration_seconds",
    "max_mode",
    "variety",
    "vocal_gender",
    "weirdness",
    "style_influence",
    "inspo",
    "custom_model",
    "magic_wand_my_taste",
    "styles",
    "exclude",
    "generation_protocol",
    "qa_focus",
}

# Enumerations. The schema declares the same sets; a test keeps them equal.
MODEL_VALUES = {"v6", "v6-wild", "v6-mini"}  # v6 generation, from 2026-09-09; older models retired
PROJECT_MODES = {"full_control"}
SUNO_UI_TABS = {"simple", "advanced", "sounds"}  # "custom" is not a tab
FULL_CONTROL_UI_TAB = "advanced"
DURATION_MODES = {"auto", "custom"}

# Keys whose value is a Suno input packet.
SUNO_PACKET_KEYS = {"suno_test_packet", "suno_packet"}

# Packets under templates/ are empty contracts, not compiled packets, so their
# field values are not checked -- only their structure.
CONTRACT_DIR_PARTS = {"templates"}

# Fallback used only if the schema file is unreadable; the schema is authoritative.
DEFAULT_CONSTRAINTS: dict[str, int] = {
    "styles_hard_max_chars": 1000,
    "exclude_hard_max_chars": 1000,
    "styles_recommended_min_chars": 450,
    "styles_recommended_max_chars": 850,
    "styles_warning_below_chars": 400,
    "exclude_preferred_max_chars": 350,
    "weirdness_min": 0,
    "weirdness_max": 100,
    "style_influence_min": 0,
    "style_influence_max": 100,
    "duration_min_seconds": 10,
    "duration_max_seconds": 360,
    "variety_min": 0,
    "variety_max": 4,
}

# "female" contains "male", so match whole words only.
VOCAL_GENDER_PATTERN = re.compile(r"\b(male|female)\b", re.IGNORECASE)


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def load_suno_constraints(root: Path) -> dict[str, int]:
    """Read Suno limits from the schema so they are defined in exactly one place.

    D020 keeps two kinds of claim apart: `platform_constraints` describes the
    platform (violating it is an ERROR) and `project_policy` describes what this
    project prefers (deviating is a WARNING). Both are merged here because the
    validator needs the numbers; the severity difference is applied at the point
    of use, not by mixing the sources.
    """
    constraints = dict(DEFAULT_CONSTRAINTS)
    schema_path = root / SUNO_SCHEMA_REL
    if not schema_path.exists():
        return constraints
    try:
        data = yaml.safe_load(schema_path.read_text(encoding="utf-8"))
    except Exception:
        return constraints
    data = data or {}
    for block in ("platform_constraints", "project_policy"):
        declared = data.get(block)
        if not isinstance(declared, dict):
            continue
        for key in DEFAULT_CONSTRAINTS:
            value = declared.get(key)
            if _is_int(value):
                constraints[key] = value
    return constraints


def validate_styles_limits(data: Any, max_chars: int = 1000, source: str = "<memory>") -> list[str]:
    """Guard every `styles` string anywhere in a document against the hard maximum.

    This is the repository-wide safety net; `classify_styles_length` handles the
    recommended-range bands for packets. Pass the value loaded from the schema.
    """
    errors: list[str] = []

    def walk(node: Any, path: str = "root") -> None:
        if isinstance(node, dict):
            if isinstance(node.get("styles"), str):
                actual = len(node["styles"])
                if actual > max_chars:
                    errors.append(
                        f"[STYLES_HARD_MAX] {source}:{path}.styles is {actual} chars; "
                        f"hard maximum is {max_chars} -> compress Styles or move "
                        f"negatives to Exclude"
                    )
                declared = node.get("styles_char_count")
                if declared is not None and declared != actual:
                    errors.append(
                        f"[STYLES_COUNT] {source}:{path}.styles_char_count={declared} "
                        f"but actual={actual} -> update styles_char_count to {actual}"
                    )
            for key, value in node.items():
                walk(value, f"{path}.{key}")
        elif isinstance(node, list):
            for index, value in enumerate(node):
                walk(value, f"{path}[{index}]")

    walk(data)
    return errors


def classify_styles_length(
    length: int, constraints: dict[str, int], label: str = "packet"
) -> Finding | None:
    """Classify a compiled packet's Styles length per D016.

    Bands: empty -> ERROR; below warning threshold -> WARNING_STRONG;
    below or above the recommended range -> WARNING; inside it -> None.
    Exceeding the hard maximum is reported by `validate_styles_limits`.
    """
    rec_min = constraints["styles_recommended_min_chars"]
    rec_max = constraints["styles_recommended_max_chars"]
    warn_below = constraints["styles_warning_below_chars"]

    if length == 0:
        return Finding(
            ERROR,
            f"[STYLES_EMPTY] {label}.styles is empty -> compile Styles before generating",
        )
    if length < warn_below:
        return Finding(
            WARNING_STRONG,
            f"[STYLES_TOO_SHORT] {label}.styles is {length} chars; below {warn_below} -> "
            f"likely missing the hero performance detail the Master Engine requires",
        )
    if length < rec_min:
        return Finding(
            WARNING,
            f"[STYLES_BELOW_TARGET] {label}.styles is {length} chars; recommended range "
            f"is {rec_min}-{rec_max} -> consider more hero or arrangement detail",
        )
    if length > rec_max:
        return Finding(
            WARNING,
            f"[STYLES_ABOVE_TARGET] {label}.styles is {length} chars; recommended range "
            f"is {rec_min}-{rec_max} -> reduced headroom, risk of prompt overload",
        )
    return None


def _check_exclude(packet: dict[str, Any], label: str, constraints: dict[str, int]) -> list[Finding]:
    """Exclude has its own platform cap (ERROR) and a project preference (WARNING)."""
    exclude = packet.get("exclude")
    if not isinstance(exclude, str) or not exclude:
        return []
    hard_max = constraints["exclude_hard_max_chars"]
    if len(exclude) > hard_max:
        return [
            Finding(
                ERROR,
                f"[EXCLUDE_HARD_MAX] {label}.exclude is {len(exclude)} chars; hard maximum "
                f"is {hard_max} -> keep only observed failure modes",
            )
        ]
    preferred = constraints["exclude_preferred_max_chars"]
    if len(exclude) > preferred:
        return [
            Finding(
                WARNING,
                f"[EXCLUDE_LENGTH] {label}.exclude is {len(exclude)} chars; preferred "
                f"max is {preferred} -> exclude only observed failure modes",
            )
        ]
    return []


def _check_slider(
    packet: dict[str, Any],
    field: str,
    label: str,
    constraints: dict[str, int],
) -> list[Finding]:
    """Validate one creative slider is numeric and inside its configured range."""
    if field not in packet:
        return []
    value = packet[field]
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return [
            Finding(
                ERROR,
                f"[SLIDER_TYPE] {label}.{field}={value!r} is not a number -> "
                f"use a numeric percent value",
            )
        ]
    low = constraints[f"{field}_min"]
    high = constraints[f"{field}_max"]
    if not low <= value <= high:
        return [
            Finding(
                ERROR,
                f"[SLIDER_RANGE] {label}.{field}={value} is outside {low}-{high} -> "
                f"set a percent value inside the allowed range",
            )
        ]
    return []


def _check_vocal_gender(packet: dict[str, Any], label: str) -> list[Finding]:
    """Instrumental tracks must not declare a Male/Female vocal gender.

    The UI keeps both buttons enabled with an empty Lyrics box, and their effect
    on an instrumental generation is unverified, so the packet selects nothing
    (`null`). Any not-applicable wording is also accepted; nothing is forced.
    """
    if packet.get("instrumental") is not True:
        return []
    value = packet.get("vocal_gender")
    if isinstance(value, str) and VOCAL_GENDER_PATTERN.search(value):
        return [
            Finding(
                ERROR,
                f"[VOCAL_GENDER] {label}.vocal_gender={value!r} while instrumental=true -> "
                f"use null; nothing is selected for an instrumental packet",
            )
        ]
    return []


def _check_ui_mapping(packet: dict[str, Any], label: str) -> list[Finding]:
    """project_mode is intent; suno_ui_tab is the observed tab it maps to."""
    findings: list[Finding] = []
    mode = packet.get("project_mode")
    tab = packet.get("suno_ui_tab")
    if mode is not None and mode not in PROJECT_MODES:
        findings.append(
            Finding(
                ERROR,
                f"[PROJECT_MODE] {label}.project_mode={mode!r} is not one of "
                f"{', '.join(sorted(PROJECT_MODES))}",
            )
        )
    if tab is not None and tab not in SUNO_UI_TABS:
        findings.append(
            Finding(
                ERROR,
                f"[UI_TAB] {label}.suno_ui_tab={tab!r} is not a current Suno tab "
                f"({', '.join(sorted(SUNO_UI_TABS))}) -> 'custom' is no longer a UI value",
            )
        )
    elif mode == "full_control" and tab is not None and tab != FULL_CONTROL_UI_TAB:
        findings.append(
            Finding(
                ERROR,
                f"[UI_TAB_MAPPING] {label}.suno_ui_tab={tab!r} but project_mode=full_control maps "
                f"to {FULL_CONTROL_UI_TAB!r} in the current adapter",
            )
        )
    return findings


def _check_instrumental_lyrics(packet: dict[str, Any], label: str) -> list[Finding]:
    """The Advanced tab has no Instrumental toggle: intent maps to an empty Lyrics box."""
    if packet.get("instrumental") is not True:
        return []
    lyrics = packet.get("lyrics")
    if lyrics is None or (isinstance(lyrics, str) and not lyrics.strip()):
        return []
    return [
        Finding(
            ERROR,
            f"[INSTRUMENTAL_LYRICS] {label}.instrumental=true but lyrics is not empty -> "
            f"the current UI treats an empty Lyrics box as instrumental; clear it",
        )
    ]


def _check_duration(packet: dict[str, Any], label: str, constraints: dict[str, int]) -> list[Finding]:
    """duration_mode auto leaves the slider alone; custom needs seconds inside the slider range."""
    mode = packet.get("duration_mode")
    seconds = packet.get("duration_seconds")
    if mode is None:
        return []
    if mode not in DURATION_MODES:
        return [
            Finding(
                ERROR,
                f"[DURATION_MODE] {label}.duration_mode={mode!r} is not one of "
                f"{', '.join(sorted(DURATION_MODES))}",
            )
        ]
    if mode == "auto":
        if seconds is None:
            return []
        return [
            Finding(
                WARNING,
                f"[DURATION_IGNORED] {label}.duration_seconds={seconds!r} is ignored while "
                f"duration_mode=auto -> set null or switch to custom",
            )
        ]
    low = constraints["duration_min_seconds"]
    high = constraints["duration_max_seconds"]
    if not _is_int(seconds) or not low <= seconds <= high:
        return [
            Finding(
                ERROR,
                f"[DURATION_RANGE] {label}.duration_seconds={seconds!r} must be an integer "
                f"{low}-{high} for duration_mode=custom -> longer pieces are seed + Extend",
            )
        ]
    return []


def _check_model(packet: dict[str, Any], label: str) -> list[Finding]:
    """The model must be one of the current v6 generation; older models are retired."""
    model = packet.get("model")
    if not model or model in MODEL_VALUES:  # empty string is a template placeholder
        return []
    return [
        Finding(
            ERROR,
            f"[MODEL] {label}.model={model!r} is not a current model "
            f"({', '.join(sorted(MODEL_VALUES))}) -> older models are retired for generation",
        )
    ]


def _check_max_mode(packet: dict[str, Any], label: str) -> list[Finding]:
    """Max Mode is a boolean toggle. On costs 2x credits and maximises consistency."""
    if "max_mode" not in packet:
        return []
    value = packet["max_mode"]
    if isinstance(value, bool):
        return []
    return [
        Finding(
            ERROR,
            f"[MAX_MODE] {label}.max_mode={value!r} is not a boolean -> "
            f"true (2x credits) or false",
        )
    ]


def _check_variety(packet: dict[str, Any], label: str, constraints: dict[str, int]) -> list[Finding]:
    """Variety is a 0-4 integer slider; 1 is the 'Normal' default."""
    if "variety" not in packet:
        return []
    value = packet["variety"]
    low = constraints["variety_min"]
    high = constraints["variety_max"]
    if not _is_int(value) or not low <= value <= high:
        return [
            Finding(
                ERROR,
                f"[VARIETY_RANGE] {label}.variety={value!r} must be an integer {low}-{high} "
                f"(1 = Normal)",
            )
        ]
    return []


def validate_suno_packet(
    packet: dict[str, Any],
    label: str,
    constraints: dict[str, int],
    *,
    compiled: bool = True,
) -> list[Finding]:
    """Validate one Suno input packet.

    `compiled=False` marks an empty template contract: structure and enum
    mappings are still required, but value-level guidance is skipped.
    """
    findings: list[Finding] = []

    missing = sorted(SUNO_REQUIRED_FIELDS.difference(packet.keys()))
    if missing:
        findings.append(
            Finding(
                ERROR,
                f"[PACKET_FIELDS] {label} missing Suno fields: {', '.join(missing)} -> "
                f"every UI control must be declared explicitly",
            )
        )

    findings.extend(_check_model(packet, label))
    findings.extend(_check_ui_mapping(packet, label))
    findings.extend(_check_slider(packet, "weirdness", label, constraints))
    findings.extend(_check_slider(packet, "style_influence", label, constraints))
    findings.extend(_check_vocal_gender(packet, label))

    if not compiled:
        return findings

    findings.extend(_check_instrumental_lyrics(packet, label))
    findings.extend(_check_duration(packet, label, constraints))
    findings.extend(_check_max_mode(packet, label))
    findings.extend(_check_variety(packet, label, constraints))

    styles = packet.get("styles")
    if isinstance(styles, str):
        styles_finding = classify_styles_length(len(styles), constraints, label)
        if styles_finding is not None:
            findings.append(styles_finding)

    findings.extend(_check_exclude(packet, label, constraints))
    return findings


def _find_suno_packets(node: Any, path: str = "root") -> Iterator[tuple[str, dict[str, Any]]]:
    if isinstance(node, dict):
        for key, value in node.items():
            next_path = f"{path}.{key}"
            if key in SUNO_PACKET_KEYS and isinstance(value, dict):
                yield next_path, value
            yield from _find_suno_packets(value, next_path)
    elif isinstance(node, list):
        for index, value in enumerate(node):
            yield from _find_suno_packets(value, f"{path}[{index}]")


def validate_suno_packets(root: Path, constraints: dict[str, int]) -> list[Finding]:
    findings: list[Finding] = []
    for path in iter_yaml_files(root):
        try:
            data = yaml.safe_load(path.read_text(encoding="utf-8"))
        except Exception:
            continue  # already reported by validate_yaml_files
        source = str(path.relative_to(root))
        compiled = not CONTRACT_DIR_PARTS.intersection(path.parts)
        for packet_path, packet in _find_suno_packets(data):
            findings.extend(
                validate_suno_packet(
                    packet, f"{source}:{packet_path}", constraints, compiled=compiled
                )
            )
    return findings
