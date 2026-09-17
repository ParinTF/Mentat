"""KernelForge backend package.

Every module is import-safe without Postgres, Redis or Docker running: no
connection is opened at import time, only configuration values are read.
"""
