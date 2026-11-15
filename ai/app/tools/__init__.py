"""Live organizational data tools, Python side.

Python ORCHESTRATES: it offers the model a fixed list of tool definitions, validates what the model asks for, and asks NODE to run
it. Node is the only authority (identity, organization, permissions, live-data switch, budgets, audit). Nothing here reads a
database, and nothing the model or the request body says can widen what is offered or where a call goes.
"""
