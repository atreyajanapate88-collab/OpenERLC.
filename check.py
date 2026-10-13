"""Run:  python check.py   -> tells you exactly which part of OpenERLC is broken."""
import asyncio, os, sys
from pathlib import Path
try:
    from dotenv import load_dotenv
    env_dir = Path(__file__).parent
    load_dotenv(env_dir / ".env")
    load_dotenv(env_dir / "env.txt")
except ImportError:
    print("[!] python-dotenv missing -> run: pip install -r requirements.txt")

MODEL = os.environ.get("OPENERLC_MODEL", "openai/gpt-oss-120b")
WIKI = "https://emergency-response-liberty-county.fandom.com/api.php"

def ok(m): print("[OK]  ", m)
def bad(m): print("[FAIL]", m)

async def main():
    import httpx
    print(f"Python {sys.version.split()[0]} | model {MODEL}\n")

    # 1. AI key + model
    if not os.environ.get("GROQ_API_KEY"):
        bad("GROQ_API_KEY not found. Put it in .env or env.txt (same folder as app.py)")
    else:
        try:
            from groq import AsyncGroq
            r = await AsyncGroq().chat.completions.create(
                model=MODEL,
                max_tokens=30,
                messages=[{"role": "user", "content": "Say hi in 3 words"}],
            )
            ok(f"Groq works: {r.choices[0].message.content!r}")
        except Exception as e:
            bad(f"AI call failed -> {type(e).__name__}: {e}")
            print("       (If the model is unavailable, set OPENERLC_MODEL to a model enabled for your Groq account.)")

    # 2. Wiki
    try:
        async with httpx.AsyncClient(timeout=15, headers={"User-Agent": "OpenERLC/1.0"}) as c:
            r = await c.get(WIKI, params={"action": "query", "list": "search", "srsearch": "police", "format": "json"})
            hits = r.json()["query"]["search"]
            ok(f"Wiki works: {len(hits)} results, first = {hits[0]['title'] if hits else 'none'}")
    except Exception as e:
        bad(f"Wiki failed (HTTP {getattr(r,'status_code','?')}) -> {type(e).__name__}: {e}")

    # 3. ER:LC API
    key = os.environ.get("ERLC_SERVER_KEY")
    if not key:
        print("[skip] ERLC_SERVER_KEY not set -> live stats off (chat still works)")
    else:
        try:
            async with httpx.AsyncClient(timeout=15) as c:
                r = await c.get("https://api.erlc.gg/v2/server", headers={"server-key": key})
            if r.status_code == 200:
                ok(f"ER:LC API works: {r.json().get('Name')} ({r.json().get('CurrentPlayers')} players)")
            else:
                bad(f"ER:LC API HTTP {r.status_code}: {r.text[:200]}")
        except Exception as e:
            bad(f"ER:LC API failed -> {type(e).__name__}: {e}")

        # 4. MCP subprocess
        try:
            from mcp import ClientSession, StdioServerParameters
            from mcp.client.stdio import stdio_client
            p = StdioServerParameters(command=sys.executable, args=[str(Path(__file__).parent / "server.py")], env=dict(os.environ))
            async with stdio_client(p) as (rd, wr):
                async with ClientSession(rd, wr) as s:
                    await s.initialize()
                    ok(f"MCP server starts: {len((await s.list_tools()).tools)} tools")
        except Exception as e:
            bad(f"MCP server failed -> {type(e).__name__}: {e}")

asyncio.run(main())
