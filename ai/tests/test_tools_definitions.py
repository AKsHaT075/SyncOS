"""The eight tool definitions: exact set, exact schemas, strict validation, and drift detection against the Node-generated contract."""
import json
from pathlib import Path

import pytest

from app.tools import definitions as D

NAMES = ["get_project_overview", "get_team", "get_workload_summary", "list_my_schedule", "list_my_tasks", "list_project_members", "list_project_tasks", "list_projects"]

# Pinned BY HAND, independently of contract.json: a hand edit of the contract (or a Node change that is exported without review)
# breaks this table. property -> (type, required?)
PINNED = {
    "get_project_overview": {"project": ("string", True)},
    "get_team": {"team": ("string", False)},
    "get_workload_summary": {"scope": ("string", False)},
    "list_my_schedule": {"range": ("string", False), "types": ("array", False)},
    "list_my_tasks": {"status": ("string", False), "due": ("string", False), "relation": ("string", False), "limit": ("integer", False)},
    "list_project_members": {"project": ("string", True)},
    "list_project_tasks": {"project": ("string", True), "status": ("string", False), "due": ("string", False), "assignee": ("string", False), "limit": ("integer", False)},
    "list_projects": {"status": ("string", False), "overdue": ("boolean", False), "name_contains": ("string", False), "sort": ("string", False), "limit": ("integer", False)},
}
ENUMS = {
    ("get_workload_summary", "scope"): ["me", "my_team", "organization"],
    ("list_my_schedule", "range"): ["today", "next_7_days", "this_week", "next_14_days"],
    ("list_projects", "sort"): ["due", "open_tasks", "overdue_tasks"],
    ("list_project_tasks", "assignee"): ["me", "any"],
}


def test_exactly_the_eight_approved_tools_in_a_fixed_order():
    assert sorted(D.DEFINITIONS) == NAMES
    assert [t["name"] for t in D.model_tools()] == NAMES
    assert len(D.model_tools()) == 8


@pytest.mark.parametrize("name", NAMES)
def test_every_schema_matches_the_pinned_contract_and_is_closed(name):
    schema = D.DEFINITIONS[name].parameters
    assert schema["type"] == "object" and schema["additionalProperties"] is False
    props = {k: (v["type"], k in schema.get("required", [])) for k, v in schema["properties"].items()}
    assert props == PINNED[name]
    assert D.DEFINITIONS[name].description.strip()


def test_enums_match():
    for (tool, prop), values in ENUMS.items():
        assert D.DEFINITIONS[tool].parameters["properties"][prop]["enum"] == values


def test_no_identity_or_query_capability_is_exposed():
    forbidden = {"organization", "organizationId", "user", "userId", "team_id", "teamId", "filter", "query", "pipeline", "role", "id", "url", "$where"}
    for d in D.DEFINITIONS.values():
        assert not forbidden & set(d.parameters["properties"]) - {"team"}, d.name


def test_the_shipped_contract_file_is_what_is_loaded():
    raw = json.loads(D.CONTRACT_PATH.read_text())
    assert [t["name"] for t in raw["tools"]] == NAMES and raw["version"] == 1
    assert {t["name"]: t["parameters"] for t in raw["tools"]} == {n: D.DEFINITIONS[n].parameters for n in NAMES}


def test_unknown_tool_and_unexpected_argument_are_rejected():
    assert D.DEFINITIONS.get("delete_project") is None and D.DEFINITIONS.get("list_my_tasks ") is None
    d = D.DEFINITIONS["list_projects"]
    assert D.invalid_fields(d, {}) == []
    assert D.invalid_fields(d, {"organization": "x"}) == [""]  # an unknown key is reported without echoing it
    assert D.invalid_fields(d, {"status": "Active", "limit": 5, "overdue": True, "sort": "due", "name_contains": "a"}) == []


@pytest.mark.parametrize("name,args,fields", [
    ("list_projects", {"limit": 0}, ["limit"]), ("list_projects", {"limit": 21}, ["limit"]), ("list_projects", {"limit": True}, ["limit"]),
    ("list_projects", {"limit": "5"}, ["limit"]), ("list_projects", {"sort": "name"}, ["sort"]), ("list_projects", {"overdue": "yes"}, ["overdue"]),
    ("list_projects", {"name_contains": ""}, ["name_contains"]), ("list_projects", {"name_contains": "x" * 61}, ["name_contains"]),
    ("get_project_overview", {}, ["project"]), ("get_project_overview", {"project": ""}, ["project"]), ("get_project_overview", {"project": 5}, ["project"]),
    ("get_workload_summary", {"scope": "everyone"}, ["scope"]), ("get_workload_summary", {"scope": {"$ne": "me"}}, ["scope"]),
    ("list_my_schedule", {"types": []}, ["types"]), ("list_my_schedule", {"types": ["meeting", "x"]}, ["types[1]"]), ("list_my_schedule", {"types": "task"}, ["types"]),
    ("get_team", {"team": 5}, ["team"]), ("list_project_tasks", {"project": "A", "assignee": "bob"}, ["assignee"]),
])
def test_invalid_arguments_report_field_names_only(name, args, fields):
    assert D.invalid_fields(D.DEFINITIONS[name], args) == fields


def test_non_object_arguments_are_invalid():
    for bad in (None, [], "x", 5):
        assert D.invalid_fields(D.DEFINITIONS["list_projects"], bad) == [""]


# ---- the loader refuses a contract that is not exactly the approved one -------------------------------------------------------------

def _write(tmp_path: Path, mutate):
    raw = json.loads(D.CONTRACT_PATH.read_text())
    mutate(raw)
    path = tmp_path / "c.json"
    path.write_text(json.dumps(raw))
    return path


def test_loader_refuses_a_missing_extra_or_renamed_tool(tmp_path):
    with pytest.raises(D.ContractError):
        D.load_definitions(_write(tmp_path, lambda r: r["tools"].pop()))
    with pytest.raises(D.ContractError):
        D.load_definitions(_write(tmp_path, lambda r: r["tools"].append({**r["tools"][0], "name": "delete_everything"})))
    with pytest.raises(D.ContractError):
        D.load_definitions(_write(tmp_path, lambda r: r["tools"][0].update(name="get_project_overviews")))
    with pytest.raises(D.ContractError):
        D.load_definitions(_write(tmp_path, lambda r: r["tools"].append(dict(r["tools"][0]))))


def test_loader_refuses_open_or_unsupported_schemas(tmp_path):
    with pytest.raises(D.ContractError):
        D.load_definitions(_write(tmp_path, lambda r: r["tools"][0]["parameters"].update(additionalProperties=True)))
    with pytest.raises(D.ContractError):
        D.load_definitions(_write(tmp_path, lambda r: r["tools"][0]["parameters"]["properties"]["project"].update(pattern="^.*$")))  # an unknown keyword is never ignored
    with pytest.raises(D.ContractError):
        D.load_definitions(tmp_path / "missing.json")


def test_python_definitions_cannot_be_changed_by_a_request():
    # the list offered to the model is built from the fixed table only; mutating a returned copy does not change the next one
    first = D.model_tools()
    first[0]["name"] = "evil"
    assert D.model_tools()[0]["name"] == NAMES[0]
