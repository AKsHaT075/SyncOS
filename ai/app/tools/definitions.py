"""The eight live-data tools as the MODEL sees them.

Source of truth: NODE's registry. `contract.json` is generated from it (`node backend/scripts/export-ai-tool-contract.js`) and both
test suites compare against it, so drift on either side fails a test. This module loads it STRICTLY: the exact eight names, every
schema closed (`additionalProperties: false`) and made only of keywords the validator below understands (an unknown keyword is
refused at load, never silently ignored). The definitions are fixed at import: a request cannot add, remove or change one.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

CONTRACT_PATH = Path(__file__).with_name("contract.json")
EXPECTED_NAMES = frozenset({
    "list_my_tasks", "list_my_schedule", "list_projects", "get_project_overview",
    "list_project_members", "list_project_tasks", "get_team", "get_workload_summary",
})
_KEYWORDS = {"$schema", "type", "properties", "required", "additionalProperties", "enum", "items", "minItems", "maxItems", "minLength", "maxLength", "minimum", "maximum"}


class ContractError(RuntimeError):
    pass


@dataclass(frozen=True)
class ToolDefinition:
    name: str
    description: str
    parameters: dict[str, Any]

    def for_model(self) -> dict:
        return {"name": self.name, "description": self.description, "parameters": self.parameters}


def _check_schema(schema: Any, *, root: bool = False) -> None:
    if not isinstance(schema, dict) or not set(schema) <= _KEYWORDS:
        raise ContractError("unsupported schema keyword")
    kind = schema.get("type")
    if kind not in {"string", "integer", "boolean", "array", "object"}:
        raise ContractError("unsupported schema type")
    if kind == "object":
        if schema.get("additionalProperties") is not False:
            raise ContractError("object schemas must be closed")
        props = schema.get("properties", {})
        if not isinstance(props, dict) or not set(schema.get("required", [])) <= set(props):
            raise ContractError("bad object schema")
        for sub in props.values():
            _check_schema(sub)
    elif kind == "array":
        _check_schema(schema.get("items"))
    elif root:
        raise ContractError("tool parameters must be an object")


def load_definitions(path: Path = CONTRACT_PATH) -> dict[str, ToolDefinition]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        items = raw["tools"]
        defs = {t["name"]: ToolDefinition(t["name"], str(t["description"]), t["parameters"]) for t in items}
    except (OSError, ValueError, KeyError, TypeError):
        raise ContractError("tool contract is unreadable") from None
    if len(defs) != len(items) or set(defs) != EXPECTED_NAMES:
        raise ContractError("tool contract does not list exactly the eight approved tools")
    for d in defs.values():
        if not d.description.strip() or len(d.description) > 2000:
            raise ContractError("bad tool description")
        _check_schema(d.parameters, root=True)
    return defs


DEFINITIONS: dict[str, ToolDefinition] = load_definitions()


def model_tools() -> list[dict]:
    """What is offered to Groq. Sorted, fixed, never derived from a request."""
    return [DEFINITIONS[name].for_model() for name in sorted(DEFINITIONS)]


def invalid_fields(definition: ToolDefinition, arguments: Any) -> list[str]:
    """Names of the invalid argument fields ([] = valid). Unknown keys are reported as '' (a model-supplied key is never echoed)."""
    problems: list[str] = []
    _validate(definition.parameters, arguments, "", problems)
    return sorted(set(problems))[:10]


def _validate(schema: dict, value: Any, path: str, out: list[str]) -> None:
    kind = schema["type"]
    if kind == "object":
        if not isinstance(value, dict):
            return out.append(path)
        props = schema.get("properties", {})
        for key in value:
            if key not in props:
                out.append("")
        for key in schema.get("required", []):
            if key not in value:
                out.append(key if not path else f"{path}.{key}")
        for key, sub in props.items():
            if key in value:
                _validate(sub, value[key], key if not path else f"{path}.{key}", out)
        return None
    if kind == "string":
        ok = isinstance(value, str) and len(value) >= schema.get("minLength", 0) and len(value) <= schema.get("maxLength", 10**9)
    elif kind == "integer":
        ok = isinstance(value, int) and not isinstance(value, bool) and schema.get("minimum", value) <= value <= schema.get("maximum", value)
    elif kind == "boolean":
        ok = isinstance(value, bool)
    else:  # array
        if not isinstance(value, list) or not schema.get("minItems", 0) <= len(value) <= schema.get("maxItems", 10**6):
            return out.append(path)
        for i, item in enumerate(value):
            _validate(schema["items"], item, f"{path}[{i}]", out)
        return None
    if ok and "enum" in schema and value not in schema["enum"]:
        ok = False
    if not ok:
        out.append(path)
    return None
