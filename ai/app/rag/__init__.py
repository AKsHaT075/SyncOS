"""Phase 5: permission-aware retrieval-augmented answers.

Python embeds the question and searches the vector store; NODE decides which hits may be used (organization, document
access, trash, current version, extraction/embedding state) before any text exists on this side. The vector payload is
never an authorization source. Python holds no RBAC.
"""
