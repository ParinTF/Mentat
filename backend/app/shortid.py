"""Shareable short ids: 8 Crockford-base32 characters (40 bits of entropy).

Crockford base32 excludes I, L, O and U so a shared URL cannot be misread.
Collisions are handled by the caller via `generate_unique`.
"""

from __future__ import annotations

import secrets

ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
LENGTH = 8


def encode(value: bytes, length: int = LENGTH) -> str:
    if length <= 0 or length > 13:
        raise ValueError("length must be between 1 and 13")
    number = int.from_bytes(value, "big")
    chars: list[str] = []
    for _ in range(length):
        chars.append(ALPHABET[number % 32])
        number //= 32
    return "".join(chars)


def generate(length: int = LENGTH) -> str:
    if length > 13:
        raise ValueError("at most 13 characters (65 bits) come from one call")
    return encode(secrets.token_bytes(8), length)


def generate_unique(exists, length: int = LENGTH, attempts: int = 5) -> str:
    """Generate an id that `exists(candidate)` reports as unused."""
    for _ in range(attempts):
        candidate = generate(length)
        if not exists(candidate):
            return candidate
    raise RuntimeError("could not generate a unique short_id")


def is_valid(candidate: str, length: int = LENGTH) -> bool:
    return (
        isinstance(candidate, str)
        and len(candidate) == length
        and all(char in ALPHABET for char in candidate)
    )
