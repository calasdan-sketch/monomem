// `monomem oauth on <https url> | off | pair | list`: the switch for connecting claude.ai and ChatGPT as remote MCP
// connectors (docs/oauth.md). Off by default. Each connected app is an ordinary key: `monomem keys remove` ends it.

const HELP = `monomem oauth: let claude.ai or ChatGPT connect over the internet (off by default)

  monomem oauth on <https url>   switch on; <url> is the public https address of the MCP port
  monomem oauth off              switch off (OAuth addresses answer "not found"; connected apps stop within an hour)
  monomem oauth pair             show a one-time pairing code (10 minutes) to type on the consent page
  monomem oauth list             connected apps (remove one with: monomem keys remove "<name>")

Needs HTTPS reaching this computer (Tailscale Funnel or Cloudflare Tunnel). Read docs/oauth.md first.`;

export async function oauthCmd(args: string[]): Promise<void> {
  const st = await import("../oauth/state.js");
  const sub = args[0];
  try {
    if (sub === "on") {
      const cur = st.readState();
      const url = args[1] ?? cur.issuer;
      if (!url) throw new Error("Give the public https address: monomem oauth on https://<your address>   (see docs/oauth.md)");
      st.normalizeIssuer(url); // a bad address is refused before anyone is asked to confirm
      // An agent's shell must not open an internet sign-in door on its own: a person types yes at a terminal.
      await (await import("../operator-gate.js")).requireOperator("oauth on (apps on the internet may ask to connect)");
      const s = st.setEnabled(true, url);
      console.log(
        `OAuth is on. Apps connect to:\n  ${s.issuer}/mcp\n\n` +
          "The Monomem server must be running (monomem start) and reachable at that address over https.\n" +
          `If requests are refused with "host not allowed", set MONOMEM_ALLOWED_HOSTS=${new URL(s.issuer!).hostname}\n` +
          "When an app asks to connect, run: monomem oauth pair"
      );
    } else if (sub === "off") {
      st.setEnabled(false);
      console.log("OAuth is off. Connected apps stop working within an hour (their key expires and cannot be renewed while off). To end one now: monomem keys remove \"<name>\" (see monomem oauth list).");
    } else if (sub === "pair") {
      const s = st.readState();
      if (!s.enabled) throw new Error("OAuth is off. Switch it on first: monomem oauth on https://<your address>");
      // The code is the person gate on the consent page; an agent's shell (no terminal) must not be able to mint one.
      if (!(process.stdin.isTTY && process.stdout.isTTY)) throw new Error("Refused: run monomem oauth pair yourself in a terminal. The code is how Monomem knows a person approved the app.");
      const code = st.newPairCode();
      console.log(`Pairing code (works once, for 10 minutes):\n\n  ${code}\n\nType it on the Monomem page that opened in your browser. Only you should see it.`);
    } else if (sub === "list") {
      const { grantsForList } = await import("../oauth/routes.js");
      const s = st.readState();
      console.log(`OAuth is ${s.enabled ? `on at ${s.issuer}` : "off"}.`);
      const grants = grantsForList();
      if (!grants.length) console.log("No connected apps.");
      for (const g of grants) {
        console.log(`  ${g.label}  (${g.scope === "write" ? "read and write" : "read"}; app calls itself "${g.client_name}"; returns to ${g.redirect_host}; since ${new Date(g.created_at).toISOString().slice(0, 10)})`);
      }
      if (grants.length) console.log('Remove one: monomem keys remove "<name>"');
    } else {
      console.log(HELP);
      if (sub && sub !== "help" && sub !== "--help" && sub !== "-h") process.exitCode = 1;
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
}
