import dotenv from "dotenv";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Groq from "groq-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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

const MODEL = process.env.OPENERLC_MODEL || "openai/gpt-oss-120b";
const WIKI = "https://emergency-response-liberty-county.fandom.com/api.php";
const outcomes = [];
function ok(message) {
  outcomes.push(true);
  console.log("[OK]  ", message);
}
function bad(message) {
  outcomes.push(false);
  console.error("[FAIL]", message);
}

console.log(`Node.js ${process.version} | model ${MODEL}\n`);

if (!process.env.GROQ_API_KEY) {
  bad("GROQ_API_KEY not found. Put it in .env or env.txt (same folder as app.js).");
} else {
  try {
    const response = await new Groq().chat.completions.create({
      model: MODEL,
      max_tokens: 30,
      messages: [{ role: "user", content: "Say hi in 3 words" }],
    });
    ok(`Groq works: ${JSON.stringify(response.choices[0].message.content)}`);
  } catch (error) {
    bad(`AI call failed -> ${error.name}: ${error.message}`);
    console.log("       (If the model is unavailable, set OPENERLC_MODEL to a model enabled for your Groq account.)");
  }
}

try {
  const url = new URL(WIKI);
  url.search = new URLSearchParams({
    action: "query",
    list: "search",
    srsearch: "police",
    format: "json",
  });
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    headers: { "User-Agent": "OpenERLC/1.0" },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const hits = (await response.json()).query.search;
  ok(`Wiki works: ${hits.length} results, first = ${hits[0]?.title || "none"}`);
} catch (error) {
  bad(`Wiki failed -> ${error.name}: ${error.message}`);
}

const key = process.env.ERLC_SERVER_KEY;
if (!key) {
  console.log("[skip] ERLC_SERVER_KEY not set -> live stats off (chat still works)");
} else {
  try {
    const response = await fetch("https://api.erlc.gg/v2/server", {
      headers: { "server-key": key },
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    const data = JSON.parse(text);
    ok(`ER:LC API works: ${data.Name} (${data.CurrentPlayers} players)`);
  } catch (error) {
    bad(`ER:LC API failed -> ${error.name}: ${error.message}`);
  }

  let client;
  let transport;
  try {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(ROOT, "server.js")],
      env: process.env,
    });
    client = new Client({ name: "openerlc-check", version: "1.0.0" });
    await client.connect(transport);
    const { tools } = await client.listTools();
    ok(`MCP server starts: ${tools.length} tools`);
  } catch (error) {
    bad(`MCP server failed -> ${error.name}: ${error.message}`);
  } finally {
    if (client) await client.close().catch(() => {});
    if (transport) await transport.close().catch(() => {});
  }
}

if (outcomes.includes(false)) process.exitCode = 1;
