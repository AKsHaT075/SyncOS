"""Script detection for the deterministic "no answer" message. Not language identification: it only needs to pick the
right script for the three languages Sync OS ships messages in."""
from __future__ import annotations

NO_ANSWER = {
    "en": "I could not find information about this in the documents you have access to.",
    "hi": "आपके पास उपलब्ध दस्तावेज़ों में इस बारे में मुझे कोई जानकारी नहीं मिली।",
    "pa": "ਤੁਹਾਡੇ ਕੋਲ ਉਪਲਬਧ ਦਸਤਾਵੇਜ਼ਾਂ ਵਿੱਚ ਮੈਨੂੰ ਇਸ ਬਾਰੇ ਕੋਈ ਜਾਣਕਾਰੀ ਨਹੀਂ ਮਿਲੀ।",
}


def detect_script(text: str) -> str:
    deva = sum(1 for c in text if "ऀ" <= c <= "ॿ")
    guru = sum(1 for c in text if "਀" <= c <= "੿")
    if deva > guru and deva >= 2:
        return "hi"
    if guru > deva and guru >= 2:
        return "pa"
    return "en"


def no_answer_message(question: str) -> str:
    return NO_ANSWER[detect_script(question)]
