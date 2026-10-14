import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import dotenv from "dotenv";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
for (const file of [".env", "env.txt"]) {
  try {
    const values = dotenv.parse(readFileSync(join(ROOT, file)));
    for (const [key, value] of Object.entries(values)) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

const BASE_URL = "https://api.erlc.gg";
const SERVER_KEY = (process.env.ERLC_SERVER_KEY || "").trim();
const API_KEY = (process.env.ERLC_API_KEY || "").trim();
const COMMANDS_ENABLED = process.env.ERLC_ENABLE_COMMANDS?.toLowerCase() === "true";
if (!SERVER_KEY) {
  console.error("ERLC_SERVER_KEY is not set. Get it in-game: Settings > API key.");
  process.exit(1);
}

const ERROR_CODES = {
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
};
const LOG_KEYS = ["JoinLogs", "KillLogs", "CommandLogs", "ModCalls", "EmergencyCalls"];
const INCLUDE_FLAGS = [
  "Players", "Staff", "JoinLogs", "Queue", "KillLogs",
  "CommandLogs", "ModCalls", "EmergencyCalls", "Vehicles",
];
const blockedUntil = new Map();
let authFailures = 0;
let lastCommandAt = 0;
let commandChain = Promise.resolve();

const tools = [
  {
    name: "get_server_status",
    description: "Basic server info: name, owner/co-owner IDs, player count, max players, join code, verification requirement, and team balance.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_server_snapshot",
    description: "Fetch several data sets in ONE request (preferred over many separate calls, since the API is rate limited). Always includes basic server status.",
    inputSchema: {
      type: "object",
      properties: {
        include: { type: "array", items: { type: "string", enum: INCLUDE_FLAGS } },
        limit: { type: "integer", minimum: 1, default: 50 },
      },
      required: ["include"],
    },
  },
  {
    name: "get_players",
    description: "Players currently in the server: team, callsign, location (X/Z, postal, street), permission level, and wanted stars. Names are formatted 'Name:RobloxId'.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_staff",
    description: "Server staff: Admins, Mods, and Helpers as {RobloxUserId: username} maps.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_queue",
    description: "Roblox user IDs of players waiting in the join queue.",
    inputSchema: { type: "object", properties: {} },
  },
  ...[
    ["get_join_logs", "JoinLogs", "Recent join/leave events (Join=true for joins), newest first. Timestamps are Unix epoch seconds."],
    ["get_kill_logs", "KillLogs", "Recent kill events (Killer, Killed, Timestamp), newest first."],
    ["get_command_logs", "CommandLogs", "Recent in-game commands run by players (Player, Command, Timestamp), newest first."],
    ["get_mod_calls", "ModCalls", "Recent moderator calls (Caller, Moderator who responded or null, Timestamp), newest first."],
    ["get_emergency_calls", "EmergencyCalls", "Recent emergency (911) calls: team, caller ID, responders, position, description, call number."],
  ].map(([name, key, description]) => ({
    name,
    description,
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, default: 50 } },
    },
    logKey: key,
  })),
  {
    name: "get_vehicles",
    description: "Vehicles currently spawned: name, owner, plate, livery texture, color.",
    inputSchema: { type: "object", properties: {} },
  },
];

if (COMMANDS_ENABLED) {
  tools.push({
    name: "run_command",
    description: "Run an in-game command. This AFFECTS THE LIVE GAME; confirm with the user before running anything destructive. Limited to one command per five seconds.",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  });
}

function describeError(status, body) {
  const parts = [`HTTP ${status}`];
  if (body && typeof body === "object") {
    if (body.code !== undefined) {
      parts.push(`code ${body.code}: ${ERROR_CODES[body.code] || "unrecognized code"}`);
    }
    if (body.message || body.error) parts.push(String(body.message || body.error));
  }
  if (status === 403 && body?.code === undefined) parts.push("Unauthorized: check ERLC_SERVER_KEY.");
  return parts.join(" | ");
}

async function requestApi(method, path, { params = {}, jsonBody } = {}) {
  if (authFailures >= 3) {
    throw new Error("Stopped sending requests: the server key was rejected 3 times (it was probably regenerated). Update ERLC_SERVER_KEY and restart the MCP server.");
  }
  const wait = (blockedUntil.get(path) || 0) - Date.now();
  if (wait > 0) throw new Error(`Rate limited locally for ${path}. Try again in ${Math.ceil(wait / 1000)}s.`);

  const url = new URL(path, BASE_URL);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const headers = {
    "server-key": SERVER_KEY,
    Accept: "application/json",
    ...(API_KEY ? { Authorization: API_KEY } : {}),
    ...(jsonBody ? { "Content-Type": "application/json" } : {}),
  };
  const response = await fetch(url, {
    method,
    headers,
    body: jsonBody ? JSON.stringify(jsonBody) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const remaining = response.headers.get("X-RateLimit-Remaining");
  const reset = response.headers.get("X-RateLimit-Reset");
  if (remaining === "0" && reset && /^\d+$/.test(reset)) {
    blockedUntil.set(path, Number(reset) * 1000);
  }

  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (response.status === 429) {
    const waitSeconds = Number(response.headers.get("Retry-After") || body?.retry_after || 5);
    blockedUntil.set(path, Date.now() + waitSeconds * 1000);
    throw new Error(`${describeError(429, body)} | Wait ${Math.ceil(waitSeconds)}s before retrying.`);
  }
  if (response.status === 401 || response.status === 403) authFailures += 1;
  else if (response.ok) authFailures = 0;
  if (!response.ok) throw new Error(describeError(response.status, body));
  return body;
}

function trimLogs(data, limit) {
  for (const key of LOG_KEYS) {
    const entries = data[key];
    if (!Array.isArray(entries)) continue;
    entries.sort((left, right) =>
      (right.Timestamp ?? right.StartedAt ?? 0) - (left.Timestamp ?? left.StartedAt ?? 0)
    );
    if (entries.length > limit) {
      data[key] = entries.slice(0, limit);
      data._truncated ||= {};
      data._truncated[key] = `showing ${limit} of ${entries.length}`;
    }
  }
  return data;
}

async function fetchServer(flags, limit = 50) {
  const params = Object.fromEntries([...new Set(flags)].map((flag) => [flag, "true"]));
  return trimLogs(await requestApi("GET", "/v2/server", { params }), limit);
}

async function executeTool(name, args) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  if (name === "get_server_status") return fetchServer([]);
  if (name === "get_server_snapshot") {
    if (!Array.isArray(args.include) || args.include.some((flag) => !INCLUDE_FLAGS.includes(flag))) {
      throw new Error("include must contain only supported server data flags.");
    }
    return fetchServer(args.include, args.limit ?? 50);
  }
  if (name === "get_players") {
    const data = await fetchServer(["Players"]);
    return { CurrentPlayers: data.CurrentPlayers, Players: data.Players || [] };
  }
  if (name === "get_staff") {
    const data = await fetchServer(["Staff"]);
    return data.Staff || {};
  }
  if (name === "get_queue") {
    const data = await fetchServer(["Queue"]);
    return { Queue: data.Queue || [] };
  }
  if (tool.logKey) {
    const data = await fetchServer([tool.logKey], args.limit ?? 50);
    return {
      [tool.logKey]: data[tool.logKey] || [],
      ...(data._truncated ? { _truncated: data._truncated } : {}),
    };
  }
  if (name === "get_vehicles") {
    const data = await fetchServer(["Vehicles"]);
    return { Vehicles: data.Vehicles || [] };
  }
  if (name === "run_command") {
    const command = String(args.command || "").trim();
    if (!command) throw new Error("Command is empty.");
    const run = commandChain.then(async () => {
      const wait = 5000 - (Date.now() - lastCommandAt);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      try {
        return await requestApi("POST", "/v2/server/command", { jsonBody: { command } });
      } finally {
        lastCommandAt = Date.now();
      }
    });
    commandChain = run.catch(() => {});
    return run;
  }
  throw new Error(`Unknown tool: ${name}`);
}

const server = new Server(
  { name: "erlc", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(({ logKey, ...tool }) => tool),
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const result = await executeTool(request.params.name, request.params.arguments || {});
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (error) {
    return {
      content: [{ type: "text", text: error.message }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
