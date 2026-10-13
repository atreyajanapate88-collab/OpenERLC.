"""
ER:LC (Emergency Response: Liberty County) MCP server.

Wraps the PRC Private Server API v2 (https://apidocs.erlc.gg/).

Environment variables:
  ERLC_SERVER_KEY        (required) Your private server key.
  ERLC_API_KEY           (optional) Global app key, only for public applications;
                         sent in the `Authorization` header.
  ERLC_ENABLE_COMMANDS   (optional) Set to "true" to expose the run_command tool.
                         Disabled by default because it changes the live game.
"""

import asyncio
import os
import sys
import time
from typing import Any, Literal

import httpx
from mcp.server.fastmcp import FastMCP

BASE_URL = "https://api.erlc.gg"
SERVER_KEY = os.environ.get("ERLC_SERVER_KEY", "").strip()
API_KEY = os.environ.get("ERLC_API_KEY", "").strip()
COMMANDS_ENABLED = os.environ.get("ERLC_ENABLE_COMMANDS", "").lower() == "true"

if not SERVER_KEY:
    print("ERLC_SERVER_KEY is not set. Get it in-game: Settings > API key.", file=sys.stderr)
    sys.exit(1)

# Error codes from https://apidocs.erlc.gg/error-codes
ERROR_CODES = {
    0: "Unknown error. If it persists, open an API ticket in the ER:LC Discord.",
    1001: "Error communicating with Roblox or the in-game private server.",
    1002: "Internal system error.",
    2000: "No server-key was provided.",
    2001: "Server-key is incorrectly formatted.",
    2002: "Server-key is invalid or expired (it may have been regenerated).",
    2003: "Invalid global API key.",
    2004: "This server-key is banned from the API.",
    2005: "Unauthenticated requests for multiple servers; create a public application.",
    3001: "No valid command in the request body.",
    3002: "Server is offline (no players in it).",
    4000: "Not authorized to perform this action on this server.",
    4001: "Rate limited or temporarily blocked. Check Retry-After.",
    4002: "That command is restricted.",
    4003: "That message is prohibited.",
    9998: "The resource you are accessing is restricted.",
    9999: "The in-game module is out of date. Kick all players from the server and retry.",
}

# Collections returned by /v2/server that are lists of log-style entries.
LOG_KEYS = ["JoinLogs", "KillLogs", "CommandLogs", "ModCalls", "EmergencyCalls"]

IncludeFlag = Literal[
    "Players", "Staff", "JoinLogs", "Queue", "KillLogs",
    "CommandLogs", "ModCalls", "EmergencyCalls", "Vehicles",
]

mcp = FastMCP("erlc")

_client = httpx.AsyncClient(
    base_url=BASE_URL,
    timeout=20.0,
    headers={
        "server-key": SERVER_KEY,
        "Accept": "application/json",
        **({"Authorization": API_KEY} if API_KEY else {}),
    },
)

# --- Rate-limit / failure guards -------------------------------------------------
# The docs require stopping immediately on 429 and waiting the full Retry-After,
# and recommend abandoning a key that keeps returning 403. We enforce both locally.
_blocked_until: dict[str, float] = {}  # path -> epoch seconds
_auth_failures = 0
_AUTH_FAILURE_LIMIT = 3
_command_lock = asyncio.Lock()
_last_command_at = 0.0
_COMMAND_SPACING = 5.0  # docs: 1 command / 5s (subject to change)


def _describe_error(status: int, body: Any) -> str:
    code = message = None
    if isinstance(body, dict):
        code = body.get("code")
        message = body.get("message") or body.get("error")
    parts = [f"HTTP {status}"]
    if code is not None:
        parts.append(f"code {code}: {ERROR_CODES.get(code, 'unrecognized code')}")
    if message:
        parts.append(str(message))
    if status == 403 and code is None:
        parts.append("Unauthorized: check ERLC_SERVER_KEY.")
    return " | ".join(parts)


async def _request(
    method: str,
    path: str,
    *,
    params: dict[str, str] | None = None,
    json_body: dict[str, Any] | None = None,
) -> Any:
    global _auth_failures

    if _auth_failures >= _AUTH_FAILURE_LIMIT:
        raise RuntimeError(
            "Stopped sending requests: the server key was rejected "
            f"{_AUTH_FAILURE_LIMIT} times (it was probably regenerated). "
            "Update ERLC_SERVER_KEY and restart the MCP server."
        )

    wait = _blocked_until.get(path, 0) - time.time()
    if wait > 0:
        raise RuntimeError(f"Rate limited locally for {path}. Try again in {wait:.0f}s.")

    resp = await _client.request(method, path, params=params, json=json_body)

    # Track rate-limit headers so we don't burn requests when the bucket is empty.
    remaining = resp.headers.get("X-RateLimit-Remaining")
    reset = resp.headers.get("X-RateLimit-Reset")
    if remaining == "0" and reset and reset.isdigit():
        _blocked_until[path] = float(reset)

    try:
        body = resp.json()
    except ValueError:
        body = None

    if resp.status_code == 429:
        retry_after = float(resp.headers.get("Retry-After") or (body or {}).get("retry_after") or 5)
        _blocked_until[path] = time.time() + retry_after
        raise RuntimeError(f"{_describe_error(429, body)} | Wait {retry_after:.0f}s before retrying.")

    if resp.status_code in (401, 403):
        _auth_failures += 1
    elif resp.is_success:
        _auth_failures = 0

    if not resp.is_success:
        raise RuntimeError(_describe_error(resp.status_code, body))

    return body


def _trim_logs(data: dict[str, Any], limit: int) -> dict[str, Any]:
    """Keep only the `limit` most recent entries of each log list."""
    for key in LOG_KEYS:
        entries = data.get(key)
        if isinstance(entries, list):
            entries.sort(key=lambda e: e.get("Timestamp", e.get("StartedAt", 0)), reverse=True)
            if len(entries) > limit:
                data[key] = entries[:limit]
                data.setdefault("_truncated", {})[key] = f"showing {limit} of {len(entries)}"
    return data


async def _fetch_server(flags: list[str], limit: int = 50) -> dict[str, Any]:
    params = {flag: "true" for flag in dict.fromkeys(flags)}  # dedupe: duplicates cause a 400
    data = await _request("GET", "/v2/server", params=params)
    return _trim_logs(data, limit)


# --- Tools -----------------------------------------------------------------------
@mcp.tool()
async def get_server_status() -> dict:
    """Basic server info: name, owner/co-owner IDs, player count, max players,
    join code, verification requirement, and team balance."""
    return await _fetch_server([])


@mcp.tool()
async def get_server_snapshot(include: list[IncludeFlag], limit: int = 50) -> dict:
    """Fetch several data sets in ONE request (preferred over many separate calls,
    since the API is rate limited). Always includes basic server status.

    Args:
        include: Any of Players, Staff, JoinLogs, Queue, KillLogs, CommandLogs,
                 ModCalls, EmergencyCalls, Vehicles.
        limit: Max entries per log list, newest first (default 50).
    """
    return await _fetch_server(list(include), limit)


@mcp.tool()
async def get_players() -> dict:
    """Players currently in the server: team, callsign, location (X/Z, postal,
    street), permission level, and wanted stars. Names are formatted 'Name:RobloxId'."""
    data = await _fetch_server(["Players"])
    return {"CurrentPlayers": data.get("CurrentPlayers"), "Players": data.get("Players", [])}


@mcp.tool()
async def get_staff() -> dict:
    """Server staff: Admins, Mods, and Helpers as {RobloxUserId: username} maps."""
    data = await _fetch_server(["Staff"])
    return data.get("Staff", {})


@mcp.tool()
async def get_queue() -> dict:
    """Roblox user IDs of players waiting in the join queue."""
    data = await _fetch_server(["Queue"])
    return {"Queue": data.get("Queue", [])}


@mcp.tool()
async def get_join_logs(limit: int = 50) -> dict:
    """Recent join/leave events (Join=true for joins), newest first. Timestamps are Unix epoch seconds."""
    data = await _fetch_server(["JoinLogs"], limit)
    return {"JoinLogs": data.get("JoinLogs", []), **({"_truncated": data["_truncated"]} if "_truncated" in data else {})}


@mcp.tool()
async def get_kill_logs(limit: int = 50) -> dict:
    """Recent kill events (Killer, Killed, Timestamp), newest first."""
    data = await _fetch_server(["KillLogs"], limit)
    return {"KillLogs": data.get("KillLogs", []), **({"_truncated": data["_truncated"]} if "_truncated" in data else {})}


@mcp.tool()
async def get_command_logs(limit: int = 50) -> dict:
    """Recent in-game commands run by players (Player, Command, Timestamp), newest first."""
    data = await _fetch_server(["CommandLogs"], limit)
    return {"CommandLogs": data.get("CommandLogs", []), **({"_truncated": data["_truncated"]} if "_truncated" in data else {})}


@mcp.tool()
async def get_mod_calls(limit: int = 50) -> dict:
    """Recent moderator calls (Caller, Moderator who responded or null, Timestamp), newest first."""
    data = await _fetch_server(["ModCalls"], limit)
    return {"ModCalls": data.get("ModCalls", []), **({"_truncated": data["_truncated"]} if "_truncated" in data else {})}


@mcp.tool()
async def get_emergency_calls(limit: int = 50) -> dict:
    """Recent emergency (911) calls: team, caller ID, responders, position, description, call number."""
    data = await _fetch_server(["EmergencyCalls"], limit)
    return {"EmergencyCalls": data.get("EmergencyCalls", []), **({"_truncated": data["_truncated"]} if "_truncated" in data else {})}


@mcp.tool()
async def get_vehicles() -> dict:
    """Vehicles currently spawned: name, owner, plate, livery texture, color."""
    data = await _fetch_server(["Vehicles"])
    return {"Vehicles": data.get("Vehicles", [])}


if COMMANDS_ENABLED:

    @mcp.tool()
    async def run_command(command: str) -> dict:
        """Run an in-game command as virtual server management (e.g. ':h Hello everyone!').
        This AFFECTS THE LIVE GAME (messages, kicks, bans, etc.). Confirm with the user
        before running anything destructive. Limited to ~1 command per 5 seconds; some
        commands are restricted by the API (error 4002). The server must have players in it.

        Args:
            command: The full command including its prefix, e.g. ':m Server restart soon'.
        """
        global _last_command_at
        command = command.strip()
        if not command:
            raise RuntimeError("Command is empty.")
        async with _command_lock:
            gap = _COMMAND_SPACING - (time.time() - _last_command_at)
            if gap > 0:
                await asyncio.sleep(gap)
            try:
                return await _request("POST", "/v2/server/command", json_body={"command": command})
            finally:
                _last_command_at = time.time()


if __name__ == "__main__":
    mcp.run()  # stdio transport
